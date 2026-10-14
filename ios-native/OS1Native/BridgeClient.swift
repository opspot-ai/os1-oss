import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @AppStorage("serverURL") private var storedServerURL = ""
    @AppStorage("accessToken") private var storedAccessToken = ""
    @AppStorage("lastBundledServerURL") private var lastBundledServerURL = ""
    @AppStorage("lastBundledAccessToken") private var lastBundledAccessToken = ""
    @Published var selectedAgent: Agent = .voice
    @Published var messages: [Message] = [
        Message(role: .agent(.voice), text: "Voice is ready. Tap the mic, or type below.", date: Date())
    ]
    @Published var isSending = false
    @Published var error: String?
    @Published var bridgeStatus = "Checking OS1 bridge..."
    @Published var bridgeOnline = false

    private static var defaultServerURL: String {
        let generated = GeneratedBridgeConfig.serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if validServerURL(generated) {
            return generated
        }
        return cleanBundleValue("OS1ServerURL")
    }

    private static var defaultAccessToken: String {
        let generated = GeneratedBridgeConfig.accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if validAccessToken(generated) {
            return generated
        }
        return cleanBundleValue("OS1AccessToken")
    }

    private static func cleanBundleValue(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return "" }
        return value.contains("$(") ? "" : value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var serverURL: String {
        get {
            let stored = storedServerURL.trimmingCharacters(in: .whitespacesAndNewlines)
            return Self.validServerURL(stored) ? stored : Self.defaultServerURL
        }
        set {
            storedServerURL = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            objectWillChange.send()
        }
    }

    var accessToken: String {
        get {
            let stored = storedAccessToken.trimmingCharacters(in: .whitespacesAndNewlines)
            return Self.validAccessToken(stored) ? stored : Self.defaultAccessToken
        }
        set {
            storedAccessToken = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            objectWillChange.send()
        }
    }

    var isConfigured: Bool {
        Self.validServerURL(serverURL) && Self.validAccessToken(accessToken)
    }

    var webURL: URL? {
        guard var components = URLComponents(string: serverURL) else { return nil }
        components.path = "/"
        components.queryItems = accessToken.isEmpty ? nil : [URLQueryItem(name: "token", value: accessToken)]
        return components.url
    }

    func resetBridgeSettings() {
        storedServerURL = ""
        storedAccessToken = ""
        error = nil
        bridgeOnline = false
        bridgeStatus = "Checking OS1 bridge..."
        objectWillChange.send()
    }

    func reconcileBundledBridgeSettings() {
        let bundledURL = Self.defaultServerURL
        let bundledToken = Self.defaultAccessToken
        var changed = false

        if Self.validServerURL(bundledURL), bundledURL != lastBundledServerURL {
            storedServerURL = ""
            lastBundledServerURL = bundledURL
            changed = true
        }
        if Self.validAccessToken(bundledToken), bundledToken != lastBundledAccessToken {
            storedAccessToken = ""
            lastBundledAccessToken = bundledToken
            changed = true
        }
        if changed {
            objectWillChange.send()
        }
    }

    private static func validServerURL(_ value: String) -> Bool {
        guard let url = URL(string: value), let scheme = url.scheme, let host = url.host else {
            return false
        }
        return (scheme == "http" || scheme == "https") && !host.isEmpty
    }

    private static func validAccessToken(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && !trimmed.contains("$(")
    }

    func checkHealth() async {
        reconcileBundledBridgeSettings()
        guard let base = URL(string: serverURL), isConfigured else {
            bridgeOnline = false
            bridgeStatus = "Bridge settings needed"
            print("OS1 health skipped: bridge settings invalid")
            return
        }

        do {
            let endpoint = base.appendingPathComponent("api").appendingPathComponent("health")
            print("OS1 health GET \(endpoint.absoluteString)")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "GET"
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(accessToken, forHTTPHeaderField: "X-OS1-Token")
            request.timeoutInterval = 8

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw BridgeError.badResponse
            }
            let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let tasks = payload?["activeTasks"] as? Int
            bridgeOnline = true
            bridgeStatus = tasks.map { "OS1 bridge online - \($0) tasks" } ?? "OS1 bridge online"
            print("OS1 health OK")
        } catch {
            bridgeOnline = false
            bridgeStatus = "Bridge error: \(error.localizedDescription)"
            print("OS1 health ERROR \(error.localizedDescription)")
        }
    }

    func send(_ text: String, source: String = "voice") async -> String? {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        guard let base = URL(string: serverURL) else {
            error = "Set the OS1 server URL."
            return nil
        }

        messages.append(Message(role: .user, text: cleaned, date: Date()))
        isSending = true
        error = nil
        defer { isSending = false }

        do {
            let endpoint = base
                .appendingPathComponent("api")
                .appendingPathComponent("agents")
                .appendingPathComponent("chat")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(accessToken, forHTTPHeaderField: "X-OS1-Token")
            request.timeoutInterval = 190
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "agent": selectedAgent.rawValue,
                "source": source,
                "text": cleaned
            ])

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw BridgeError.badResponse }
            guard (200..<300).contains(http.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
                throw BridgeError.server(body)
            }

            let decoded = try JSONDecoder().decode(AgentReply.self, from: data)
            messages.append(Message(role: .agent(selectedAgent), text: decoded.reply, date: Date()))
            return decoded.reply
        } catch {
            self.error = String(describing: error)
            messages.append(Message(role: .agent(selectedAgent), text: "I could not reach the OS1 bridge: \(error.localizedDescription)", date: Date()))
            return nil
        }
    }

    func logVoiceEvent(_ event: String, chars: Int = 0, source: String = "native") async {
        guard let base = URL(string: serverURL), isConfigured else { return }

        do {
            let endpoint = base
                .appendingPathComponent("api")
                .appendingPathComponent("voice")
                .appendingPathComponent("event")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(accessToken, forHTTPHeaderField: "X-OS1-Token")
            request.timeoutInterval = 5
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "agent": selectedAgent.rawValue,
                "event": event,
                "source": source,
                "chars": chars
            ])
            _ = try await URLSession.shared.data(for: request)
        } catch {
            print("OS1 voice event log skipped: \(error.localizedDescription)")
        }
    }

    func createRealtimeSession() async throws -> RealtimeSession {
        guard let base = URL(string: serverURL), isConfigured else {
            throw BridgeError.server("Set the OS1 bridge URL and token.")
        }

        let endpoint = base
            .appendingPathComponent("api")
            .appendingPathComponent("realtime")
            .appendingPathComponent("session")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(accessToken, forHTTPHeaderField: "X-OS1-Token")
        request.timeoutInterval = 12
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "agent": selectedAgent.rawValue
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BridgeError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw BridgeError.server(body)
        }

        return try JSONDecoder().decode(RealtimeSession.self, from: data)
    }

    func executeAgentTool(name: String, argumentsJSON: String) async -> String {
        guard let base = URL(string: serverURL), isConfigured else {
            return #"{"ok":false,"error":"OS1 bridge is not configured."}"#
        }

        let argsObject: Any
        if let data = argumentsJSON.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) {
            argsObject = parsed
        } else {
            argsObject = [:]
        }

        do {
            let endpoint = base
                .appendingPathComponent("api")
                .appendingPathComponent("voice")
                .appendingPathComponent("tool")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(accessToken, forHTTPHeaderField: "X-OS1-Token")
            request.timeoutInterval = 190
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "name": name,
                "arguments": argsObject,
                "source": "native-openai-realtime"
            ])

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return #"{"ok":false,"error":"Bad bridge response."}"#
            }
            if (200..<300).contains(http.statusCode),
               let body = String(data: data, encoding: .utf8),
               !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return body
            }

            let body = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            return #"{"ok":false,"error":\#(Self.jsonString(body))}"#
        } catch {
            return #"{"ok":false,"error":\#(Self.jsonString(error.localizedDescription))}"#
        }
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let encoded = String(data: data, encoding: .utf8) else {
            return #""Bridge error.""#
        }
        return encoded
    }

    func uploadNoteCapture(audioURL: URL, duration: TimeInterval) async throws -> NoteCaptureResult {
        guard let base = URL(string: serverURL), isConfigured else {
            throw BridgeError.server("Set the OS1 bridge URL and token.")
        }

        isSending = true
        error = nil
        defer { isSending = false }

        let audioData = try await Task.detached(priority: .userInitiated) {
            try Data(contentsOf: audioURL)
        }.value
        let endpoint = base
            .appendingPathComponent("api")
            .appendingPathComponent("note")
            .appendingPathComponent("capture")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(accessToken, forHTTPHeaderField: "X-OS1-Token")
        request.timeoutInterval = 300
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "audioBase64": audioData.base64EncodedString(),
            "durationSeconds": max(0, Int(duration.rounded())),
            "filename": audioURL.lastPathComponent,
            "mimeType": "audio/mp4",
            "source": "ios-native-note-capture"
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BridgeError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw BridgeError.server(body)
        }

        return try JSONDecoder().decode(NoteCaptureResult.self, from: data)
    }

    func runNativeSmokeTest() async {
        guard isConfigured else { return }

        let originalAgent = selectedAgent
        selectedAgent = .voice
        _ = await send("Native iOS voice smoke test for Voice. Reply with a short acknowledgement.", source: "native-voice-smoke")
        do {
            let session = try await createRealtimeSession()
            print("OS1 realtime smoke OK agent=\(session.agent) model=\(session.model) voice=\(session.voice)")
        } catch {
            print("OS1 realtime smoke ERROR \(error.localizedDescription)")
        }

        selectedAgent = .assistant
        _ = await send("Native iOS voice smoke test for Assistant. Reply with a short acknowledgement.", source: "native-voice-smoke")

        selectedAgent = .note
        _ = await send("Native iOS voice smoke test for Note. Treat this as a short captured voice note.", source: "native-voice-smoke")

        selectedAgent = originalAgent
    }
}

struct NoteCaptureResult: Decodable {
    let ok: Bool
    let captureId: String
    let transcriptChars: Int
    let reply: String
    let capturePath: String?
    let receiptPath: String?
    let transcriptArtifact: String?
    let followupArtifact: String?
}

struct RealtimeSession: Decodable {
    let ok: Bool
    let agent: String
    let model: String
    let voice: String
    let clientSecret: String
    let expiresAt: Int?
}

enum BridgeError: LocalizedError {
    case badResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .badResponse:
            return "Bad bridge response."
        case .server(let message):
            return message
        }
    }
}
