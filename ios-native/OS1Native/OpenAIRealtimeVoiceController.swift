import AVFoundation
import Foundation

final class OpenAIRealtimeVoiceController: ObservableObject {
    private static let outputVoiceDrive: Float = 2.8
    private static let outputVoiceNormalizer = Float(tanh(Double(outputVoiceDrive)))

    @Published private(set) var isActive = false
    @Published private(set) var status = "Ready."
    @Published private(set) var transcript = ""

    private let inputEngine = AVAudioEngine()
    private let outputEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    private let inputPCMFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
    private let outputFloatFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
    private let audioQueue = DispatchQueue(label: "com.example.os1.realtime.audio", qos: .userInitiated)
    private let stateQueue = DispatchQueue(label: "com.example.os1.realtime.state")

    private var webSocket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var inputConverter: AVAudioConverter?
    private var inputTapInstalled = false
    private var outputEngineStarted = false
    private var currentAgent: Agent = .assistant
    private var currentVoice = "marin"
    private var lastOutputBytes = 0
    private var didStartSpeaking = false
    private var inputMutedUntil = Date.distantPast
    private var eventLogger: ((String, Int, String) async -> Void)?
    private var toolExecutor: ((String, String) async -> String)?
    private var handledToolCallIds = Set<String>()

    @MainActor
    func start(
        agent: Agent,
        session: RealtimeSession,
        eventLogger: @escaping (String, Int, String) async -> Void,
        toolExecutor: @escaping (String, String) async -> String
    ) async {
        guard !isActive else { return }
        currentAgent = agent
        currentVoice = session.voice
        self.eventLogger = eventLogger
        self.toolExecutor = toolExecutor
        transcript = ""
        lastOutputBytes = 0
        didStartSpeaking = false
        handledToolCallIds.removeAll()
        setInputMuted(for: 0)
        setStatus("Connecting \(agent.label) realtime...")

        do {
            guard await requestMicrophonePermission() else {
                setStatus("Microphone permission needed.")
                await eventLogger("openai-realtime-mic-denied", 0, "native-openai")
                return
            }

            try configureAudioSession()
            try connectWebSocket(session: session)
            try startOutputEngine()
            try startInputEngine()

            isActive = true
            setStatus("Listening through \(session.voice).")
            await eventLogger("openai-realtime-started", 0, "native-openai")
        } catch {
            stop(status: error.localizedDescription)
            await eventLogger("openai-realtime-error", min(error.localizedDescription.count, 400), "native-openai")
        }
    }

    @MainActor
    func stop(status: String = "Realtime ended.") {
        receiveTask?.cancel()
        receiveTask = nil
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil

        if inputTapInstalled {
            inputEngine.inputNode.removeTap(onBus: 0)
            inputTapInstalled = false
        }
        inputEngine.stop()
        inputEngine.reset()

        audioQueue.sync {
            playerNode.stop()
            outputEngine.stop()
            outputEngine.reset()
            outputEngineStarted = false
        }

        inputConverter = nil
        toolExecutor = nil
        handledToolCallIds.removeAll()
        isActive = false
        setStatus(status)
    }

    private func connectWebSocket(session: RealtimeSession) throws {
        guard var components = URLComponents(string: "wss://api.openai.com/v1/realtime") else {
            throw RealtimeVoiceError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "model", value: session.model)]
        guard let url = components.url else { throw RealtimeVoiceError.invalidURL }

        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("Bearer \(session.clientSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("realtime", forHTTPHeaderField: "Sec-WebSocket-Protocol")

        let socket = URLSession.shared.webSocketTask(with: request)
        webSocket = socket
        socket.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    private func startInputEngine() throws {
        let inputNode = inputEngine.inputNode
        let sourceFormat = inputNode.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: sourceFormat, to: inputPCMFormat) else {
            throw RealtimeVoiceError.audioConversionUnavailable
        }
        inputConverter = converter

        inputNode.installTap(onBus: 0, bufferSize: 2_400, format: sourceFormat) { [weak self] buffer, _ in
            guard let self else { return }
            self.audioQueue.async {
                guard let audio = self.convertInputBuffer(buffer) else { return }
                Task { [weak self] in
                    await self?.sendAudio(audio)
                }
            }
        }
        inputTapInstalled = true
        inputEngine.prepare()
        try inputEngine.start()
    }

    private func startOutputEngine() throws {
        audioQueue.sync {
            if !outputEngine.attachedNodes.contains(playerNode) {
                outputEngine.attach(playerNode)
            }
            outputEngine.connect(playerNode, to: outputEngine.mainMixerNode, format: outputFloatFormat)
            playerNode.volume = 1.0
            outputEngine.mainMixerNode.outputVolume = 1.0
            outputEngine.prepare()
        }
        try outputEngine.start()
        outputEngineStarted = true
        playerNode.play()
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
        )
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.03)
        try session.setActive(true)
        try routeBuiltInAudioToSpeakerIfNeeded(session)
        logAudioRoute(session, context: "configured")
    }

    private func routeBuiltInAudioToSpeakerIfNeeded(_ session: AVAudioSession = .sharedInstance()) throws {
        guard session.currentRoute.outputs.contains(where: { $0.portType == .builtInReceiver }) else {
            return
        }

        try session.overrideOutputAudioPort(.speaker)
        logAudioRoute(session, context: "forced-speaker")
    }

    private func logAudioRoute(_ session: AVAudioSession, context: String) {
        let inputs = session.currentRoute.inputs.map(\.portType.rawValue).joined(separator: ",")
        let outputs = session.currentRoute.outputs.map(\.portType.rawValue).joined(separator: ",")
        print("OS1 audio route context=\(context) input=\(inputs) output=\(outputs) volume=\(session.outputVolume) voiceDrive=\(Self.outputVoiceDrive)x limiter=tanh")
    }

    private func requestMicrophonePermission() async -> Bool {
        if #available(iOS 17.0, *) {
            return await AVAudioApplication.requestRecordPermission()
        }

        return await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }
    }

    private func receiveLoop() async {
        while !Task.isCancelled {
            guard let webSocket else { return }
            do {
                let message = try await webSocket.receive()
                switch message {
                case .string(let text):
                    await handleRealtimeMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        await handleRealtimeMessage(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.stop(status: "Realtime disconnected: \(error.localizedDescription)")
                }
                await log("openai-realtime-disconnected", chars: min(error.localizedDescription.count, 400))
                return
            }
        }
    }

    private func handleRealtimeMessage(_ text: String) async {
        guard
            let data = text.data(using: .utf8),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = payload["type"] as? String
        else {
            return
        }

        switch type {
        case "session.created", "session.updated":
            setStatus("Listening through \(currentVoice).")
        case "input_audio_buffer.speech_started":
            stopCurrentPlayback()
            setStatus("Hearing you...")
            await log("openai-realtime-heard")
        case "input_audio_buffer.speech_stopped":
            setStatus("\(currentAgent.label) thinking...")
        case "response.created":
            lastOutputBytes = 0
            didStartSpeaking = false
            setStatus("\(currentAgent.label) responding...")
        case "response.output_audio.delta", "response.audio.delta":
            let delta = payload["delta"] as? String
            if let delta, let audio = Data(base64Encoded: delta) {
                lastOutputBytes += audio.count
                if !didStartSpeaking {
                    didStartSpeaking = true
                    setStatus("\(currentAgent.label) speaking through \(currentVoice).")
                    await log("openai-realtime-speaking")
                }
                enqueueOutputAudio(audio)
            }
        case "response.output_audio.done", "response.audio.done":
            if lastOutputBytes > 0 {
                await log("openai-realtime-spoken", chars: min(lastOutputBytes, 6000))
                lastOutputBytes = 0
            }
            didStartSpeaking = false
            extendInputMute(duration: 0.35)
            setStatus("Listening through \(currentVoice).")
        case "response.output_audio_transcript.delta", "response.audio_transcript.delta":
            if let delta = payload["delta"] as? String, !delta.isEmpty {
                appendTranscript(delta)
            }
        case "response.function_call_arguments.done":
            await handleFunctionCallEvent(payload)
        case "conversation.item.done", "conversation.item.created":
            if let item = payload["item"] as? [String: Any] {
                await handleFunctionCallItem(item)
            }
        case "response.done":
            if lastOutputBytes > 0 {
                await log("openai-realtime-spoken", chars: min(lastOutputBytes, 6000))
                lastOutputBytes = 0
            }
            didStartSpeaking = false
            extendInputMute(duration: 0.35)
            setStatus("Listening through \(currentVoice).")
            if let response = payload["response"] as? [String: Any],
               let output = response["output"] as? [[String: Any]] {
                for item in output {
                    await handleFunctionCallItem(item)
                }
            }
        case "error":
            let message = ((payload["error"] as? [String: Any])?["message"] as? String) ?? "OpenAI realtime error"
            setStatus(message)
            await log("openai-realtime-error", chars: min(message.count, 400))
        default:
            break
        }
    }

    private func handleFunctionCallEvent(_ payload: [String: Any]) async {
        let name = payload["name"] as? String
        let callID = payload["call_id"] as? String
        let arguments = payload["arguments"] as? String
        await handleFunctionCall(name: name, callID: callID, arguments: arguments)
    }

    private func handleFunctionCallItem(_ item: [String: Any]) async {
        guard (item["type"] as? String) == "function_call" else { return }
        let name = item["name"] as? String
        let callID = item["call_id"] as? String
        let arguments = item["arguments"] as? String
        await handleFunctionCall(name: name, callID: callID, arguments: arguments)
    }

    private func handleFunctionCall(name: String?, callID: String?, arguments: String?) async {
        guard let name, !name.isEmpty, let callID, !callID.isEmpty else { return }
        guard !handledToolCallIds.contains(callID) else { return }
        handledToolCallIds.insert(callID)

        setStatus("Voice using \(name)...")
        await log("openai-realtime-tool-call", chars: min(name.count, 200))
        let output = await toolExecutor?(name, arguments ?? "{}") ?? #"{"ok":false,"error":"Tool executor unavailable."}"#

        await sendJSON([
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": callID,
                "output": output
            ]
        ])
        await sendJSON(["type": "response.create"])
        await log("openai-realtime-tool-result", chars: min(output.count, 6000))
    }

    private func sendAudio(_ data: Data) async {
        guard isActive || webSocket != nil, !data.isEmpty else { return }
        guard !isInputMuted() else { return }
        let event: [String: Any] = [
            "type": "input_audio_buffer.append",
            "audio": data.base64EncodedString()
        ]
        await sendJSON(event)
    }

    private func sendJSON(_ object: [String: Any]) async {
        guard let webSocket else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            guard let text = String(data: data, encoding: .utf8) else { return }
            try await webSocket.send(.string(text))
        } catch {
            setStatus("Realtime send failed: \(error.localizedDescription)")
            await log("openai-realtime-send-error", chars: min(error.localizedDescription.count, 400))
        }
    }

    private func convertInputBuffer(_ buffer: AVAudioPCMBuffer) -> Data? {
        guard let converter = inputConverter else { return nil }
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * inputPCMFormat.sampleRate / buffer.format.sampleRate).rounded(.up)) + 16
        guard let converted = AVAudioPCMBuffer(pcmFormat: inputPCMFormat, frameCapacity: capacity) else {
            return nil
        }

        var didProvideInput = false
        var conversionError: NSError?
        let inputBlock: AVAudioConverterInputBlock = { _, status in
            if didProvideInput {
                status.pointee = .noDataNow
                return nil
            }
            didProvideInput = true
            status.pointee = .haveData
            return buffer
        }

        converter.convert(to: converted, error: &conversionError, withInputFrom: inputBlock)
        guard conversionError == nil, converted.frameLength > 0 else { return nil }

        let audioBuffer = converted.audioBufferList.pointee.mBuffers
        guard let pointer = audioBuffer.mData, audioBuffer.mDataByteSize > 0 else { return nil }
        return Data(bytes: pointer, count: Int(audioBuffer.mDataByteSize))
    }

    private func enqueueOutputAudio(_ data: Data) {
        let frameCount = data.count / MemoryLayout<Int16>.size
        extendInputMute(duration: Double(frameCount) / outputFloatFormat.sampleRate + 0.18)
        audioQueue.async { [weak self] in
            guard let self, !data.isEmpty else { return }
            do {
                try self.routeBuiltInAudioToSpeakerIfNeeded()
            } catch {
                print("OS1 audio speaker route failed: \(error.localizedDescription)")
            }
            guard frameCount > 0,
                  let buffer = AVAudioPCMBuffer(
                    pcmFormat: self.outputFloatFormat,
                    frameCapacity: AVAudioFrameCount(frameCount)
                  ),
                  let channel = buffer.floatChannelData?[0] else {
                return
            }

            buffer.frameLength = AVAudioFrameCount(frameCount)
            data.withUnsafeBytes { rawBuffer in
                let samples = rawBuffer.bindMemory(to: Int16.self)
                for index in 0..<frameCount {
                    let normalized = Float(Int16(littleEndian: samples[index])) / 32_768.0
                    channel[index] = Self.boostOutputVoice(normalized)
                }
            }

            if !self.outputEngineStarted {
                try? self.outputEngine.start()
                self.outputEngineStarted = true
            }
            self.playerNode.scheduleBuffer(buffer)
            if !self.playerNode.isPlaying {
                self.playerNode.play()
            }
        }
    }

    private static func boostOutputVoice(_ sample: Float) -> Float {
        Float(tanh(Double(sample * outputVoiceDrive))) / outputVoiceNormalizer
    }

    private func stopCurrentPlayback() {
        audioQueue.async { [weak self] in
            self?.playerNode.stop()
            self?.playerNode.play()
        }
    }

    private func setInputMuted(for seconds: TimeInterval) {
        stateQueue.async {
            let until = seconds <= 0 ? Date.distantPast : Date().addingTimeInterval(seconds)
            if until > self.inputMutedUntil || seconds <= 0 {
                self.inputMutedUntil = until
            }
        }
    }

    private func extendInputMute(duration: TimeInterval) {
        stateQueue.async {
            let now = Date()
            let start = max(now, self.inputMutedUntil)
            self.inputMutedUntil = start.addingTimeInterval(duration)
        }
    }

    private func isInputMuted() -> Bool {
        stateQueue.sync {
            Date() < inputMutedUntil
        }
    }

    private func setStatus(_ value: String) {
        DispatchQueue.main.async {
            self.status = value
        }
    }

    private func appendTranscript(_ value: String) {
        DispatchQueue.main.async {
            self.transcript += value
        }
    }

    private func log(_ event: String, chars: Int = 0) async {
        await eventLogger?(event, chars, "native-openai")
    }
}

enum RealtimeVoiceError: LocalizedError {
    case invalidURL
    case audioConversionUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid OpenAI realtime URL."
        case .audioConversionUnavailable:
            return "The microphone audio format cannot be converted for realtime voice."
        }
    }
}
