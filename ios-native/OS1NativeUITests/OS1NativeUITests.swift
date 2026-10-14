import XCTest

final class OS1NativeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testFullOS1ShellLoads() throws {
        addUIInterruptionMonitor(withDescription: "Local Network") { alert in
            if alert.buttons["Allow"].exists {
                alert.buttons["Allow"].tap()
                return true
            }
            return false
        }

        let app = XCUIApplication()
        app.launchArguments = ["--os1-native-smoke-test"]
        app.launch()
        app.tap()

        sleep(6)

        let window = app.windows.element(boundBy: 0)
        tapTab(at: 0.375, in: window)
        sleep(3)

        tapTab(at: 0.625, in: window)
        sleep(3)

        tapTab(at: 0.875, in: window)
        sleep(3)

        XCTAssertTrue(app.exists)
    }

    func testNativeMicVoiceFlow() throws {
        addUIInterruptionMonitor(withDescription: "Microphone") { alert in
            if alert.buttons["Allow"].exists {
                alert.buttons["Allow"].tap()
                return true
            }
            if alert.buttons["OK"].exists {
                alert.buttons["OK"].tap()
                return true
            }
            return false
        }

        let app = XCUIApplication()
        app.launch()
        app.tap()
        sleep(5)

        openVoice(in: app)
        runRealtimeSession(in: app)

        if app.buttons["Notes"].waitForExistence(timeout: 4) {
            app.buttons["Notes"].tap()
        }
        runNoteCapture(in: app)

        XCTAssertTrue(app.exists)
    }

    func testNoteCaptureFlow() throws {
        addUIInterruptionMonitor(withDescription: "Microphone") { alert in
            if alert.buttons["Allow"].exists {
                alert.buttons["Allow"].tap()
                return true
            }
            if alert.buttons["OK"].exists {
                alert.buttons["OK"].tap()
                return true
            }
            return false
        }

        let app = XCUIApplication()
        app.launch()
        app.tap()
        sleep(5)

        openVoice(in: app)
        if app.buttons["Notes"].waitForExistence(timeout: 4) {
            app.buttons["Notes"].tap()
        }
        runNoteCapture(in: app)

        XCTAssertTrue(app.exists)
    }

    func testRealtimeButtonBecomesStopControl() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--os1-ui-test-hold-realtime-start"]
        app.launch()
        app.tap()
        openVoice(in: app)

        XCTAssertTrue(app.buttons["Start talking"].waitForExistence(timeout: 8))
        app.buttons["Start talking"].tap()
        XCTAssertTrue(app.buttons["Stop talking"].waitForExistence(timeout: 12))

        XCTAssertTrue(app.buttons["Stop talking"].waitForExistence(timeout: 4))
        app.buttons["Stop talking"].tap()
        XCTAssertTrue(app.buttons["Start talking"].waitForExistence(timeout: 4))
    }

    func testRealtimeDeviceAudioWindow() throws {
        addUIInterruptionMonitor(withDescription: "Microphone") { alert in
            if alert.buttons["Allow"].exists {
                alert.buttons["Allow"].tap()
                return true
            }
            if alert.buttons["OK"].exists {
                alert.buttons["OK"].tap()
                return true
            }
            return false
        }

        let app = XCUIApplication()
        app.launch()
        app.tap()
        openVoice(in: app)

        XCTAssertTrue(app.buttons["Start talking"].waitForExistence(timeout: 8))
        app.buttons["Start talking"].tap()
        XCTAssertTrue(app.buttons["Stop talking"].waitForExistence(timeout: 15))
        sleep(20)

        XCTAssertTrue(app.buttons["Stop talking"].exists)
        app.buttons["Stop talking"].tap()
        XCTAssertTrue(app.buttons["Start talking"].waitForExistence(timeout: 5))
    }

    private func tapTab(at x: CGFloat, in window: XCUIElement) {
        window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.965)).tap()
    }

    private func openVoice(in app: XCUIApplication) {
        let button = app.buttons["Open OS1 voice"]
        if button.waitForExistence(timeout: 5) {
            button.tap()
            return
        }

        app.windows.element(boundBy: 0)
            .coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.87))
            .tap()
    }

    private func runRealtimeSession(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["Start talking"].waitForExistence(timeout: 8))
        app.buttons["Start talking"].tap()
        XCTAssertTrue(app.buttons["Stop talking"].waitForExistence(timeout: 12))
        sleep(30)

        if app.buttons["Stop talking"].waitForExistence(timeout: 4) {
            app.buttons["Stop talking"].tap()
        }
        sleep(2)
    }

    private func runNoteCapture(in app: XCUIApplication) {
        XCTAssertTrue(app.buttons["Start Note capture"].waitForExistence(timeout: 8))
        app.buttons["Start Note capture"].tap()
        sleep(9)

        XCTAssertTrue(app.buttons["Stop and send Note capture"].waitForExistence(timeout: 8))
        app.buttons["Stop and send Note capture"].tap()

        let sent = app.staticTexts["Uploaded for routing."]
        let lastCapture = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Last capture")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 220) || lastCapture.waitForExistence(timeout: 2))
    }
}
