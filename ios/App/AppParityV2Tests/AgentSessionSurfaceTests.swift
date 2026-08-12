import XCTest
@testable import App

/// Build 102 showed the owner two robots at once: the new-chat hero and the
/// session loader, because "no conversation and no messages" was read as proof
/// of a new chat before the server had answered. These lock the one rule that
/// prevents it — the hero belongs to exactly one phase, and only the server can
/// grant it.
@available(iOS 17.0, *)
final class AgentSessionSurfaceTests: XCTestCase {
    func testUnresolvedRouteShowsNoHeroAndCountsAsResolving() {
        let state = AgentSessionSurfaceState.resolvingInitialRoute(requestToken: UUID())
        XCTAssertTrue(state.isResolving)
        XCTAssertFalse(state.showsNewChatHero)
    }

    func testLoadingHistoryShowsNoHero() {
        let state = AgentSessionSurfaceState.loadingHistory(
            conversationId: "conv-1", requestToken: UUID())
        XCTAssertTrue(state.isResolving)
        XCTAssertFalse(state.showsNewChatHero)
    }

    func testOnlyAServerConfirmedNewChatShowsTheHero() {
        let state = AgentSessionSurfaceState.readyNew(sessionIdentity: "local:new")
        XCTAssertTrue(state.showsNewChatHero)
        XCTAssertFalse(state.isResolving)
    }

    /// An existing conversation that happens to hold zero messages is still a
    /// conversation. Showing the hero there would offer to start something the
    /// owner already started.
    func testEmptyExistingConversationIsNotANewChat() {
        let state = AgentSessionSurfaceState.readyConversation(conversationId: "conv-1")
        XCTAssertFalse(state.showsNewChatHero)
        XCTAssertFalse(state.isResolving)
    }

    /// A failed history is not a new chat. Falling back to the hero is how a
    /// transport blip used to look exactly like "your conversation is gone".
    func testFailedHistoryOffersRetryRatherThanTheHero() {
        let state = AgentSessionSurfaceState.failedHistory(
            conversationId: "conv-1", requestToken: UUID(), message: "network")
        XCTAssertFalse(state.showsNewChatHero)
        XCTAssertFalse(state.isResolving)
    }

    /// The loader and the hero are mutually exclusive in every phase, which is
    /// the property the owner's screenshot violated.
    func testNoPhaseEverShowsBothTheLoaderAndTheHero() {
        let token = UUID()
        let phases: [AgentSessionSurfaceState] = [
            .resolvingInitialRoute(requestToken: token),
            .loadingHistory(conversationId: "conv-1", requestToken: token),
            .readyNew(sessionIdentity: "local:new"),
            .readyConversation(conversationId: "conv-1"),
            .failedHistory(conversationId: "conv-1", requestToken: token, message: "network"),
        ]
        for phase in phases {
            XCTAssertFalse(phase.isResolving && phase.showsNewChatHero,
                           "\(phase) would draw two robots")
        }
    }

    /// A response may only commit while its own request still owns the screen.
    func testOnlyResolvingPhasesCarryARequestToken() {
        let token = UUID()
        XCTAssertEqual(
            AgentSessionSurfaceState.resolvingInitialRoute(requestToken: token).requestToken, token)
        XCTAssertEqual(
            AgentSessionSurfaceState.loadingHistory(
                conversationId: "conv-1", requestToken: token).requestToken, token)
        XCTAssertEqual(
            AgentSessionSurfaceState.failedHistory(
                conversationId: "conv-1", requestToken: token, message: "x").requestToken, token)
        // A settled phase cannot be overtaken by an older in-flight response.
        XCTAssertNil(AgentSessionSurfaceState.readyNew(sessionIdentity: "local:new").requestToken)
        XCTAssertNil(
            AgentSessionSurfaceState.readyConversation(conversationId: "conv-1").requestToken)
    }

    /// New Chat mints a fresh identity, so a late pointer response carrying the
    /// previous token can be recognised as stale and dropped.
    func testNewChatTokenDoesNotMatchAnInFlightRequest() {
        let inFlight = AgentSessionSurfaceState.resolvingInitialRoute(requestToken: UUID())
        let afterNewChat = AgentSessionSurfaceState.readyNew(sessionIdentity: UUID().uuidString)
        XCTAssertNotEqual(inFlight.requestToken, afterNewChat.requestToken)
    }
}
