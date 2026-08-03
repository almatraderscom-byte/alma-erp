// swift-tools-version:5.9
// L9-B — the Mac-screen VIDEO broadcaster (ScreenCaptureKit → Agora).
// Built once on the owner's Mac (`swift build -c release`); the daemon spawns
// the produced binary when a video stream starts and kills it on stop.
import PackageDescription

let package = Package(
    name: "ScreenBroadcaster",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/AgoraIO/AgoraRtcEngine_macOS.git", from: "4.5.0"),
    ],
    targets: [
        .executableTarget(
            name: "ScreenBroadcaster",
            dependencies: [.product(name: "RtcBasic", package: "AgoraRtcEngine_macOS")]
        ),
    ]
)
