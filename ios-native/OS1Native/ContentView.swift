import AVFoundation
import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var app = AppModel()
    @StateObject private var realtime = OpenAIRealtimeVoiceController()
    @StateObject private var noteCapture = NoteCaptureRecorder()
    @State private var isVoiceOpen = false
    @State private var draft = ""
    @State private var showingSettings = false
    @State private var smokeTestStarted = false
    @State private var realtimeStartID: UUID?

    var body: some View {
        ZStack(alignment: .bottom) {
            OS1GlassBackdrop()

            OS1WebView(app: app, openVoice: {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                    isVoiceOpen = true
                }
            })
            .ignoresSafeArea()

            if !app.bridgeOnline {
                VStack {
                    Text(app.bridgeStatus)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .os1LiquidGlass(cornerRadius: 12, tint: .white.opacity(0.24))
                        .padding(.top, 10)
                    Spacer()
                }
                .padding(.horizontal, 16)
                .transition(.opacity)
            }

            VStack(spacing: 10) {
                if isVoiceOpen {
                    voicePanel
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    collapsedVoiceButton
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 82)
        }
        .task {
            await app.checkHealth()
            if ProcessInfo.processInfo.arguments.contains("--os1-native-smoke-test"), !smokeTestStarted {
                smokeTestStarted = true
                await app.runNativeSmokeTest()
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(app: app)
        }
    }

    private var collapsedVoiceButton: some View {
        HStack {
            Spacer()
            Button {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                    isVoiceOpen = true
                }
            } label: {
                Label("Voice", systemImage: "mic.fill")
                    .labelStyle(.iconOnly)
                    .font(.system(size: 22, weight: .semibold))
                    .frame(width: 58, height: 58)
                    .accessibilityLabel("Open OS1 voice")
            }
            .os1GlassProminentButton()
        }
    }

    private var voicePanel: some View {
        VStack(spacing: 12) {
            HStack {
                Picker("Agent", selection: $app.selectedAgent) {
                    ForEach(Agent.allCases) { agent in
                        Text(agent.label).tag(agent)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(isRealtimeEngaged || noteCapture.isRecording || noteCapture.isSending)

                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape.fill")
                        .frame(width: 38, height: 38)
                }
                .os1GlassButton()

                Button {
                    if isRealtimeEngaged {
                        realtimeStartID = nil
                        realtime.stop(status: "Realtime ended.")
                        Task { await app.logVoiceEvent("openai-realtime-ended", source: "native-openai") }
                    }
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                        isVoiceOpen = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 38, height: 38)
                }
                .os1GlassButton()
                .disabled(noteCapture.isRecording || noteCapture.isSending)
            }

            HStack {
                Image(systemName: app.isConfigured ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(app.isConfigured ? .green : .orange)
                Text(app.isConfigured ? "local OS1 bridge" : "server config needed")
                Spacer()
                Text(voiceStatusText)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if !realtime.transcript.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Voice transcript")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(realtime.transcript)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(12)
                .os1LiquidGlass(cornerRadius: 14, tint: .white.opacity(0.12))
            }

            if app.selectedAgent == .note {
                noteCapturePanel
            }

            if app.selectedAgent != .note {
                HStack(spacing: 10) {
                    Button {
                        Task { await toggleRealtimeSession() }
                    } label: {
                        Label(
                            isRealtimeEngaged ? "Stop talking" : "Start talking",
                            systemImage: isRealtimeEngaged ? "stop.fill" : "mic.fill"
                        )
                            .frame(maxWidth: .infinity)
                    }
                    .os1GlassProminentButton(active: isRealtimeEngaged)
                    .accessibilityLabel(isRealtimeEngaged ? "Stop talking" : "Start talking")
                    .disabled(!app.isConfigured || noteCapture.isRecording || noteCapture.isSending)
                }
            }

            HStack(spacing: 10) {
                TextField("Type to voice, assistant, or notes", text: $draft, axis: .vertical)
                    .textInputAutocapitalization(.sentences)
                    .lineLimit(1...3)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .os1LiquidGlass(cornerRadius: 12, tint: .white.opacity(0.10))

                Button {
                    Task { await sendTyped() }
                } label: {
                    Image(systemName: "paperplane.fill")
                        .frame(width: 42, height: 42)
                }
                .os1GlassButton()
                .accessibilityLabel("Send voice text")
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.isSending)
            }

            if let last = app.messages.last {
                Text(last.text)
                    .font(.footnote)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(.secondary)
            }

            if let error = app.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .os1LiquidGlass(cornerRadius: 22, tint: .white.opacity(0.20))
    }

    private var noteCapturePanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    Task { await toggleNoteCapture() }
                } label: {
                    Label(
                        noteCapture.isRecording ? "Stop & send" : "Start capture",
                        systemImage: noteCapture.isRecording ? "stop.circle.fill" : "record.circle"
                    )
                    .frame(maxWidth: .infinity)
                }
                .os1GlassProminentButton(active: noteCapture.isRecording)
                .accessibilityLabel(noteCapture.isRecording ? "Stop and send Note capture" : "Start Note capture")
                .disabled(!app.isConfigured || noteCapture.isSending || isRealtimeEngaged)

                Text(noteCapture.elapsedText)
                    .font(.system(.body, design: .monospaced))
                    .frame(width: 56, height: 42)
                    .os1LiquidGlass(cornerRadius: 12, tint: .white.opacity(0.10))
                    .accessibilityLabel("Note capture duration")
            }

            Text(noteCapture.isRecording ? "Recording until you stop it." : "When you stop, it uploads for transcription and task routing.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let result = noteCapture.lastResult {
                Text("Last capture \(result.captureId) · \(result.transcriptChars) chars")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(12)
        .os1LiquidGlass(cornerRadius: 16, tint: .white.opacity(0.12))
    }

    private var voiceStatusText: String {
        if app.selectedAgent == .note && noteCapture.hasActivity {
            return noteCapture.status
        }
        return realtime.status
    }

    private var isRealtimeEngaged: Bool {
        realtimeStartID != nil || realtime.isActive
    }

    @MainActor
    private func toggleRealtimeSession() async {
        if isRealtimeEngaged {
            realtimeStartID = nil
            realtime.stop(status: "Realtime ended.")
            await app.logVoiceEvent("openai-realtime-ended", source: "native-openai")
            return
        }

        let startID = UUID()
        realtimeStartID = startID
        if ProcessInfo.processInfo.arguments.contains("--os1-ui-test-hold-realtime-start") {
            return
        }
        do {
            let session = try await app.createRealtimeSession()
            guard realtimeStartID == startID else { return }
            await realtime.start(agent: app.selectedAgent, session: session) { event, chars, source in
                await app.logVoiceEvent(event, chars: chars, source: source)
            } toolExecutor: { name, argumentsJSON in
                await app.executeAgentTool(name: name, argumentsJSON: argumentsJSON)
            }
            guard realtimeStartID == startID else {
                realtime.stop(status: "Realtime ended.")
                return
            }
            realtimeStartID = nil
        } catch {
            guard realtimeStartID == startID else { return }
            realtimeStartID = nil
            app.error = error.localizedDescription
            await app.logVoiceEvent("openai-realtime-session-error", chars: min(error.localizedDescription.count, 400), source: "native-openai")
        }
    }

    private func sendTyped() async {
        let text = draft
        draft = ""
        _ = await app.send(text, source: "typed")
    }

    @MainActor
    private func toggleNoteCapture() async {
        if noteCapture.isRecording {
            await noteCapture.stopAndSend(app: app)
            return
        }

        realtimeStartID = nil
        realtime.stop(status: "Realtime ended.")
        do {
            try await noteCapture.start()
            await app.logVoiceEvent("note-capture-started", source: "ios-native-note-capture")
        } catch {
            app.error = error.localizedDescription
            await app.logVoiceEvent("note-capture-start-error", chars: min(error.localizedDescription.count, 400), source: "ios-native-note-capture")
        }
    }
}

@MainActor
final class NoteCaptureRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    @Published private(set) var isSending = false
    @Published private(set) var status = "Note capture ready."
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var lastResult: NoteCaptureResult?

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var startedAt: Date?
    private var audioURL: URL?

    var hasActivity: Bool {
        isRecording || isSending || lastResult != nil || elapsed > 0
    }

    var elapsedText: String {
        let total = max(0, Int(elapsed.rounded(.down)))
        return "\(total / 60):\(String(format: "%02d", total % 60))"
    }

    func start() async throws {
        guard !isRecording && !isSending else { return }

        let allowed = await requestMicrophonePermission()
        guard allowed else {
            throw BridgeError.server("Microphone access is required for Note capture.")
        }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .spokenAudio,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
        )
        try session.setPreferredSampleRate(44_100)
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("note-capture-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]

        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            throw BridgeError.server("Note recorder did not start.")
        }

        self.recorder = recorder
        self.audioURL = url
        self.startedAt = Date()
        self.elapsed = 0
        self.lastResult = nil
        self.status = "Recording..."
        self.isRecording = true
        startTimer()
    }

    func stopAndSend(app: AppModel) async {
        guard let url = audioURL else { return }
        let duration = stopRecording()
        isSending = true
        status = "Uploading capture..."

        do {
            let result = try await app.uploadNoteCapture(audioURL: url, duration: duration)
            lastResult = result
            status = "Uploaded for routing."
            try? FileManager.default.removeItem(at: url)
            await app.logVoiceEvent("note-capture-sent", chars: result.transcriptChars, source: "ios-native-note-capture")
        } catch {
            app.error = error.localizedDescription
            status = "Note capture failed."
            await app.logVoiceEvent("note-capture-send-error", chars: min(error.localizedDescription.count, 400), source: "ios-native-note-capture")
        }

        audioURL = nil
        isSending = false
    }

    private func stopRecording() -> TimeInterval {
        let duration = startedAt.map { Date().timeIntervalSince($0) } ?? elapsed
        recorder?.stop()
        recorder = nil
        startedAt = nil
        isRecording = false
        elapsed = duration
        stopTimer()
        return duration
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let startedAt = self.startedAt else { return }
                self.elapsed = Date().timeIntervalSince(startedAt)
            }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
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
}

struct OS1WebView: UIViewRepresentable {
    @ObservedObject var app: AppModel
    let openVoice: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(openVoice: openVoice)
    }

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "os1Native")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.load(app: app, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.load(app: app, in: webView)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let openVoice: () -> Void
        private var loadedURL: URL?

        init(openVoice: @escaping () -> Void) {
            self.openVoice = openVoice
        }

        func load(app: AppModel, in webView: WKWebView) {
            guard let url = app.webURL else { return }
            guard loadedURL != url else { return }
            loadedURL = url
            var printable = URLComponents(url: url, resolvingAgainstBaseURL: false)
            printable?.query = nil
            print("OS1 web load \(printable?.url?.absoluteString ?? "<invalid>")")
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "os1Native" else { return }
            openVoice()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("OS1 web navigation ERROR \(error.localizedDescription)")
            loadedURL = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("OS1 web provisional ERROR \(error.localizedDescription)")
            loadedURL = nil
        }
    }
}

struct SettingsView: View {
    @ObservedObject var app: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Bridge") {
                    TextField("Server URL", text: $app.serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    SecureField("Access token", text: $app.accessToken)
                        .textInputAutocapitalization(.never)
                }

                Section("Current") {
                    Text(app.serverURL.isEmpty ? "No server URL" : app.serverURL)
                    Text(app.accessToken.isEmpty ? "No token" : "Token saved")
                }
            }
            .navigationTitle("OS1 Settings")
            .scrollContentBackground(.hidden)
            .background(OS1GlassBackdrop())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Reset") {
                        app.resetBridgeSettings()
                    }
                    .os1GlassButton()
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .os1GlassButton()
                }
            }
        }
    }
}

struct OS1PrimaryButtonStyle: ButtonStyle {
    var active: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .padding(.vertical, 14)
            .background(active ? Color.red : Color(red: 0.78, green: 0.35, blue: 0.26))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

struct OS1IconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Color(red: 0.78, green: 0.35, blue: 0.26))
            .background(Color.white.opacity(0.85))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

struct OS1GlassBackdrop: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 0.79, green: 0.34, blue: 0.25).opacity(0.72),
                Color(red: 0.87, green: 0.80, blue: 0.64).opacity(0.84),
                Color(red: 0.47, green: 0.63, blue: 0.70).opacity(0.56)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }
}

extension View {
    @ViewBuilder
    func os1LiquidGlass(cornerRadius: CGFloat = 18, tint: Color = .white.opacity(0.16)) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            self
                .background(.ultraThinMaterial, in: shape)
                .background(tint, in: shape)
                .glassEffect(.regular, in: shape)
        } else {
            self
                .background(.ultraThinMaterial, in: shape)
                .background(tint, in: shape)
                .clipShape(shape)
        }
    }

    @ViewBuilder
    func os1GlassButton() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(OS1IconButtonStyle())
        }
    }

    @ViewBuilder
    func os1GlassProminentButton(active: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            self
                .buttonStyle(.glassProminent)
                .tint(active ? .red : Color(red: 0.78, green: 0.35, blue: 0.26))
        } else {
            self.buttonStyle(OS1PrimaryButtonStyle(active: active))
        }
    }
}
