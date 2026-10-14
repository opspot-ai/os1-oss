import Foundation

enum Agent: String, CaseIterable, Identifiable, Codable {
    case voice
    case assistant
    case note

    var id: String { rawValue }

    var label: String {
        switch self {
        case .voice: return "Voice"
        case .assistant: return "Assistant"
        case .note: return "Notes"
        }
    }

    var subtitle: String {
        switch self {
        case .voice: return "realtime operator"
        case .assistant: return "chief of staff"
        case .note: return "voice notes"
        }
    }
}

struct Message: Identifiable {
    enum Role {
        case user
        case agent(Agent)
    }

    let id = UUID()
    let role: Role
    let text: String
    let date: Date
}

struct AgentReply: Decodable {
    let ok: Bool
    let agent: String
    let source: String?
    let reply: String
}
