# AlmaWidget — manual `project.pbxproj` integration plan

This document is the **exact** checklist for wiring the `AlmaWidget` WidgetKit
extension into `ios/App/App.xcodeproj/project.pbxproj` **by hand**. The parent
session performs the edit — this file only specifies what to add.

- pbxproj format in this repo: `archiveVersion = 1`, **`objectVersion = 48`**
  (Xcode 8-era; `compatibilityVersion = "Xcode 8.0"`). All new objects use the
  same 24-hex-character UUID style already in the file.
- The four Swift/plist source files already exist under `ios/App/AlmaWidget/`.
  Do **not** re-add an asset catalog or entitlements — v1 uses neither.
- Nothing here touches the existing `App` target's build settings except the
  two additions it needs: a **new build phase** ("Embed Foundation Extensions")
  and a **new dependency** on the widget target.

---

## 0. Reserved object IDs

All new IDs are stable, unique, and prefixed `B1AA22` (24 hex chars total).
None of these collide with existing IDs in the project (verified against the
current `project.pbxproj`).

| ID                         | Object kind                        | Represents                                             |
|----------------------------|------------------------------------|--------------------------------------------------------|
| `B1AA2200000000000000A001` | PBXNativeTarget                    | `AlmaWidgetExtension` target (app-extension)           |
| `B1AA2200000000000000A002` | PBXFileReference (product)         | `AlmaWidgetExtension.appex` (BUILT_PRODUCTS_DIR)       |
| `B1AA2200000000000000A003` | PBXFileReference                   | `AlmaWidgetBundle.swift`                                |
| `B1AA2200000000000000A004` | PBXFileReference                   | `AlmaWidget.swift`                                      |
| `B1AA2200000000000000A005` | PBXFileReference                   | `AlmaWidget/Info.plist`                                 |
| `B1AA2200000000000000B001` | PBXBuildFile                       | `AlmaWidgetBundle.swift` in Sources (widget)           |
| `B1AA2200000000000000B002` | PBXBuildFile                       | `AlmaWidget.swift` in Sources (widget)                 |
| `B1AA2200000000000000B003` | PBXBuildFile                       | `AlmaWidgetExtension.appex` in Embed (App target)      |
| `B1AA2200000000000000C001` | PBXSourcesBuildPhase               | widget Sources phase                                    |
| `B1AA2200000000000000C002` | PBXFrameworksBuildPhase            | widget Frameworks phase (empty)                        |
| `B1AA2200000000000000C003` | PBXResourcesBuildPhase             | widget Resources phase (empty)                          |
| `B1AA2200000000000000C004` | PBXCopyFilesBuildPhase             | "Embed Foundation Extensions" on **App** target        |
| `B1AA2200000000000000D001` | XCConfigurationList                | widget target config list                               |
| `B1AA2200000000000000D002` | XCBuildConfiguration (Debug)       | widget Debug                                            |
| `B1AA2200000000000000D003` | XCBuildConfiguration (Release)     | widget Release                                          |
| `B1AA2200000000000000E001` | PBXGroup                           | `AlmaWidget` group                                      |
| `B1AA2200000000000000F001` | PBXTargetDependency                | App → widget dependency                                 |
| `B1AA2200000000000000F002` | PBXContainerItemProxy              | proxy for the dependency                                |

Existing IDs referenced below (do not change):

| ID                         | Object                                          |
|----------------------------|-------------------------------------------------|
| `504EC3031FED79650016851F` | `App` PBXNativeTarget                           |
| `504EC3001FED79650016851F` | `App` Sources build phase                       |
| `504EC2FB1FED79650016851F` | mainGroup                                        |
| `504EC3051FED79650016851F` | `Products` group                                |
| `504EC2FC1FED79650016851F` | PBXProject object                               |

---

## 1. PBXBuildFile section

Append inside `/* Begin PBXBuildFile section */ … /* End … */`:

```
		B1AA2200000000000000B001 /* AlmaWidgetBundle.swift in Sources */ = {isa = PBXBuildFile; fileRef = B1AA2200000000000000A003 /* AlmaWidgetBundle.swift */; };
		B1AA2200000000000000B002 /* AlmaWidget.swift in Sources */ = {isa = PBXBuildFile; fileRef = B1AA2200000000000000A004 /* AlmaWidget.swift */; };
		B1AA2200000000000000B003 /* AlmaWidgetExtension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = B1AA2200000000000000A002 /* AlmaWidgetExtension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };
```

## 2. PBXFileReference section

Append inside the PBXFileReference section:

```
		B1AA2200000000000000A002 /* AlmaWidgetExtension.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = AlmaWidgetExtension.appex; sourceTree = BUILT_PRODUCTS_DIR; };
		B1AA2200000000000000A003 /* AlmaWidgetBundle.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AlmaWidgetBundle.swift; sourceTree = "<group>"; };
		B1AA2200000000000000A004 /* AlmaWidget.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AlmaWidget.swift; sourceTree = "<group>"; };
		B1AA2200000000000000A005 /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
```

> The `.appex` product's `path` (`AlmaWidgetExtension.appex`) matches the target's
> `PRODUCT_NAME`/`productName` (`AlmaWidgetExtension`), not the bundle id.

## 3. PBXFrameworksBuildPhase section

Add a new empty Frameworks phase for the widget (the App's existing one is
untouched):

```
		B1AA2200000000000000C002 /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
```

## 4. PBXGroup section

### 4a. New `AlmaWidget` group

```
		B1AA2200000000000000E001 /* AlmaWidget */ = {
			isa = PBXGroup;
			children = (
				B1AA2200000000000000A003 /* AlmaWidgetBundle.swift */,
				B1AA2200000000000000A004 /* AlmaWidget.swift */,
				B1AA2200000000000000A005 /* Info.plist */,
			);
			path = AlmaWidget;
			sourceTree = "<group>";
		};
```

### 4b. Add the group to the mainGroup (`504EC2FB1FED79650016851F`)

Insert `B1AA2200000000000000E001 /* AlmaWidget */,` into its `children` array,
e.g. right after the `504EC3061FED79650016851F /* App */,` line:

```
		504EC2FB1FED79650016851F = {
			isa = PBXGroup;
			children = (
				504EC3061FED79650016851F /* App */,
				B1AA2200000000000000E001 /* AlmaWidget */,      /* <-- ADD */
				504EC3051FED79650016851F /* Products */,
				7F8756D8B27F46E3366F6CEA /* Pods */,
				27E2DDA53C4D2A4D1A88CE4A /* Frameworks */,
			);
			sourceTree = "<group>";
		};
```

### 4c. Add the `.appex` product to the `Products` group (`504EC3051FED79650016851F`)

```
		504EC3051FED79650016851F /* Products */ = {
			isa = PBXGroup;
			children = (
				504EC3041FED79650016851F /* App.app */,
				B1AA2200000000000000A002 /* AlmaWidgetExtension.appex */,   /* <-- ADD */
			);
			name = Products;
			sourceTree = "<group>";
		};
```

## 5. PBXNativeTarget section

### 5a. New widget target

```
		B1AA2200000000000000A001 /* AlmaWidgetExtension */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = B1AA2200000000000000D001 /* Build configuration list for PBXNativeTarget "AlmaWidgetExtension" */;
			buildPhases = (
				B1AA2200000000000000C001 /* Sources */,
				B1AA2200000000000000C002 /* Frameworks */,
				B1AA2200000000000000C003 /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = AlmaWidgetExtension;
			productName = AlmaWidgetExtension;
			productReference = B1AA2200000000000000A002 /* AlmaWidgetExtension.appex */;
			productType = "com.apple.product-type.app-extension";
		};
```

### 5b. Add the "Embed Foundation Extensions" copy phase to the **App** target

Edit the existing `App` target (`504EC3031FED79650016851F`): add the new copy
phase to its `buildPhases` (**append after** `[CP] Embed Pods Frameworks`) and
add the target dependency to its `dependencies`:

```
		504EC3031FED79650016851F /* App */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 504EC3161FED79650016851F /* Build configuration list for PBXNativeTarget "App" */;
			buildPhases = (
				6634F4EFEBD30273BCE97C65 /* [CP] Check Pods Manifest.lock */,
				504EC3001FED79650016851F /* Sources */,
				504EC3011FED79650016851F /* Frameworks */,
				504EC3021FED79650016851F /* Resources */,
				9592DBEFFC6D2A0C8D5DEB22 /* [CP] Embed Pods Frameworks */,
				B1AA2200000000000000C004 /* Embed Foundation Extensions */,   /* <-- ADD */
			);
			buildRules = (
			);
			dependencies = (
				B1AA2200000000000000F001 /* PBXTargetDependency */,           /* <-- ADD */
			);
			name = App;
			productName = App;
			productReference = 504EC3041FED79650016851F /* App.app */;
			productType = "com.apple.product-type.application";
		};
```

## 6. PBXProject section — register the target

Add the widget target to the project's `targets` array
(`504EC2FC1FED79650016851F`). Optionally add a `TargetAttributes` entry for
clean automatic signing:

```
			targets = (
				504EC3031FED79650016851F /* App */,
				B1AA2200000000000000A001 /* AlmaWidgetExtension */,           /* <-- ADD */
			);
```

Optional (recommended) inside `attributes.TargetAttributes`:

```
				TargetAttributes = {
					504EC3031FED79650016851F = {
						CreatedOnToolsVersion = 9.2;
						LastSwiftMigration = 1100;
						ProvisioningStyle = Automatic;
					};
					B1AA2200000000000000A001 = {                              /* <-- ADD */
						CreatedOnToolsVersion = 15.0;
						ProvisioningStyle = Automatic;
					};
				};
```

## 7. PBXCopyFilesBuildPhase section (new section)

`objectVersion = 48` has no existing PBXCopyFilesBuildPhase section, so add a
whole new section (anywhere among the object sections — the `.pbxproj` object
graph is order-independent). `dstSubfolderSpec = 13` == PlugIns/Extensions.

```
/* Begin PBXCopyFilesBuildPhase section */
		B1AA2200000000000000C004 /* Embed Foundation Extensions */ = {
			isa = PBXCopyFilesBuildPhase;
			buildActionMask = 2147483647;
			dstPath = "";
			dstSubfolderSpec = 13;
			files = (
				B1AA2200000000000000B003 /* AlmaWidgetExtension.appex in Embed Foundation Extensions */,
			);
			name = "Embed Foundation Extensions";
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXCopyFilesBuildPhase section */
```

## 8. PBXResourcesBuildPhase section

Add a new **empty** Resources phase for the widget (v1 ships no bundled
resources — the Info.plist is consumed via `INFOPLIST_FILE`, not a resource):

```
		B1AA2200000000000000C003 /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
```

## 9. PBXSourcesBuildPhase section

Add the widget's Sources phase (both Swift files):

```
		B1AA2200000000000000C001 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				B1AA2200000000000000B002 /* AlmaWidget.swift in Sources */,
				B1AA2200000000000000B001 /* AlmaWidgetBundle.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
```

## 10. PBXTargetDependency + PBXContainerItemProxy (new sections)

`objectVersion = 48` has neither section yet; add both.

```
/* Begin PBXContainerItemProxy section */
		B1AA2200000000000000F002 /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = 504EC2FC1FED79650016851F /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = B1AA2200000000000000A001 /* AlmaWidgetExtension */;
			remoteInfo = AlmaWidgetExtension;
		};
/* End PBXContainerItemProxy section */

/* Begin PBXTargetDependency section */
		B1AA2200000000000000F001 /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = B1AA2200000000000000A001 /* AlmaWidgetExtension */;
			targetProxy = B1AA2200000000000000F002 /* PBXContainerItemProxy */;
		};
/* End PBXTargetDependency section */
```

## 11. XCBuildConfiguration section — widget Debug & Release

Add both. Settings match the task spec: bundle id `com.almatraders.erp.widget`,
deployment target 16.0, Swift 5.0, automatic signing, team `5D9FLR3MMA`,
`INFOPLIST_FILE = AlmaWidget/Info.plist`, **generate-infoplist off**
(`GENERATE_INFOPLIST_FILE = NO`), `SKIP_INSTALL = YES`.

```
		B1AA2200000000000000D002 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 6;
				DEVELOPMENT_TEAM = 5D9FLR3MMA;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = AlmaWidget/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
					"@executable_path/../../Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.almatraders.erp.widget;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SKIP_INSTALL = YES;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
				SWIFT_OPTIMIZATION_LEVEL = "-Onone";
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Debug;
		};
		B1AA2200000000000000D003 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				CURRENT_PROJECT_VERSION = 6;
				DEVELOPMENT_TEAM = 5D9FLR3MMA;
				GENERATE_INFOPLIST_FILE = NO;
				INFOPLIST_FILE = AlmaWidget/Info.plist;
				IPHONEOS_DEPLOYMENT_TARGET = 16.0;
				LD_RUNPATH_SEARCH_PATHS = (
					"$(inherited)",
					"@executable_path/Frameworks",
					"@executable_path/../../Frameworks",
				);
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = com.almatraders.erp.widget;
				PRODUCT_NAME = "$(TARGET_NAME)";
				SKIP_INSTALL = YES;
				SWIFT_OPTIMIZATION_LEVEL = "-Owholemodule";
				SWIFT_VERSION = 5.0;
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
```

> Note: `PRODUCT_NAME = "$(TARGET_NAME)"` resolves to `AlmaWidgetExtension`,
> which is why the product ref path is `AlmaWidgetExtension.appex`. The bundle
> **identifier** is separately `com.almatraders.erp.widget` — as required so the
> extension nests under the host app id `com.almatraders.erp`.

## 12. XCConfigurationList section — widget list

```
		B1AA2200000000000000D001 /* Build configuration list for PBXNativeTarget "AlmaWidgetExtension" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				B1AA2200000000000000D002 /* Debug */,
				B1AA2200000000000000D003 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
```

---

## 13. Post-edit verification checklist

1. **Open in Xcode** — the project should load with no "project damaged" error
   (proves the object graph is internally consistent; a single dangling ID
   breaks the load).
2. **Target list** shows both `App` and `AlmaWidgetExtension`.
3. `AlmaWidgetExtension` → **General**: bundle id `com.almatraders.erp.widget`,
   deployment target iOS 16.0.
4. **App target → Build Phases → Embed Foundation Extensions** lists
   `AlmaWidgetExtension.appex` with `RemoveHeadersOnCopy` (the "Code Sign On
   Copy"/attributes checkbox area).
5. **App target → Build Phases → Dependencies** (or the implicit dependency via
   the embed) includes `AlmaWidgetExtension`.
6. Build the `App` scheme for a device/simulator → both targets compile and the
   `.appex` embeds under `App.app/PlugIns/`.
7. Run on device, long-press home screen → **+** → search "ALMA ERP" → add the
   small and medium widgets; tapping tiles opens `almaerp://…` deep links.

### Signing note

The widget must be signed with the **same team** (`5D9FLR3MMA`) and an App ID
`com.almatraders.erp.widget`. With automatic signing Xcode provisions it on
first build. No App Group or shared entitlement is needed for v1 (no shared
data). If a future version shares auth/data, add an App Group entitlement to
**both** targets then.

---

## Live Activity additions

The "Business Pulse" Live Activity (lock screen + Dynamic Island) adds three new
source files split across the two targets, one shared file compiled into **both**,
a `WidgetBundle` body change, a `Main.storyboard` `customClass` change, and an
`Info.plist` key in **both** plists. ActivityKit is **iOS 16.1+**.

### A. New files and which target(s) compile each

| File                                       | App target | Widget target |
|--------------------------------------------|:----------:|:-------------:|
| `App/PulseActivityAttributes.swift`        | ✅ (drives) | ✅ (renders)   |
| `App/LiveActivityBridge.swift`             | ✅          | —             |
| `App/AlmaBridgeViewController.swift`       | ✅          | —             |
| `AlmaWidget/PulseLiveActivity.swift`       | —          | ✅            |

`PulseActivityAttributes.swift` lives physically in `App/` but is added to **both**
targets' Sources build phases — it is the shared attributes contract. (It carries
its own `#if canImport(ActivityKit)` + `@available(iOS 16.1, *)` guards, so adding
it to the widget target is safe.)

### B. `AlmaWidgetBundle` body — add `PulseLiveActivity()` under an availability check

`WidgetBundle` `@WidgetBundleBuilder` bodies **cannot use `if #available(...)`**
inline (the builder has no `buildLimitedAvailability` support in a way that lets a
bare `if #available` sit next to another `Widget` at the top level). The correct
pattern is a **nested `WidgetBundle`** whose whole type is annotated
`@available(iOS 16.1, *)`, referenced from the main bundle via a small helper that
the builder *can* gate. Concretely:

```swift
import WidgetKit
import SwiftUI

@main
struct AlmaWidgetBundle: WidgetBundle {
    var body: some Widget {
        AlmaWidget()
        // Live Activity — only present on iOS 16.1+.
        pulseLiveActivity
    }

    @WidgetBundleBuilder
    private var pulseLiveActivity: some Widget {
        if #available(iOS 16.1, *) {
            PulseLiveActivity()
        }
    }
}
```

`@WidgetBundleBuilder` **does** support `if #available` inside a builder-typed
member (it synthesizes `buildLimitedAvailability`), so hoisting the availability
check into the `pulseLiveActivity` computed property compiles cleanly while the
top-level `body` stays availability-free. Do **not** annotate `PulseLiveActivity`'s
declaration site inline in `body`.

### C. `project.pbxproj` additions — reserved IDs (prefix `C1AA33`)

Add four new file references and their build-file entries, placed into the correct
Sources phases. All IDs below are new, 24-hex-char, and prefixed `C1AA33` (they do
not collide with the existing `504EC3…`, `B1AA22…` IDs).

| ID                         | Object kind             | Represents                                                        |
|----------------------------|-------------------------|-------------------------------------------------------------------|
| `C1AA3300000000000000A001` | PBXFileReference        | `App/PulseActivityAttributes.swift`                               |
| `C1AA3300000000000000A002` | PBXFileReference        | `App/LiveActivityBridge.swift`                                    |
| `C1AA3300000000000000A003` | PBXFileReference        | `App/AlmaBridgeViewController.swift`                              |
| `C1AA3300000000000000A004` | PBXFileReference        | `AlmaWidget/PulseLiveActivity.swift`                             |
| `C1AA3300000000000000B001` | PBXBuildFile            | PulseActivityAttributes.swift in **App** Sources                 |
| `C1AA3300000000000000B002` | PBXBuildFile            | LiveActivityBridge.swift in **App** Sources                      |
| `C1AA3300000000000000B003` | PBXBuildFile            | AlmaBridgeViewController.swift in **App** Sources                |
| `C1AA3300000000000000B004` | PBXBuildFile            | PulseLiveActivity.swift in **Widget** Sources                    |
| `C1AA3300000000000000B005` | PBXBuildFile            | PulseActivityAttributes.swift in **Widget** Sources (2nd ref)    |

Notes on the build-file rows:

- `PulseActivityAttributes.swift` needs **two** distinct `PBXBuildFile` rows
  (`B001` for the App Sources phase, `B005` for the widget Sources phase) that both
  point at the **same** file reference `A001`. A file compiled into two targets gets
  one `PBXFileReference` and one `PBXBuildFile` per target.

**PBXBuildFile section** — append:

```
		C1AA3300000000000000B001 /* PulseActivityAttributes.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1AA3300000000000000A001 /* PulseActivityAttributes.swift */; };
		C1AA3300000000000000B002 /* LiveActivityBridge.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1AA3300000000000000A002 /* LiveActivityBridge.swift */; };
		C1AA3300000000000000B003 /* AlmaBridgeViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1AA3300000000000000A003 /* AlmaBridgeViewController.swift */; };
		C1AA3300000000000000B004 /* PulseLiveActivity.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1AA3300000000000000A004 /* PulseLiveActivity.swift */; };
		C1AA3300000000000000B005 /* PulseActivityAttributes.swift in Sources */ = {isa = PBXBuildFile; fileRef = C1AA3300000000000000A001 /* PulseActivityAttributes.swift */; };
```

**PBXFileReference section** — append (paths are relative to each file's group; the
three `App/…` files go in the existing `App` group, `PulseLiveActivity.swift` in the
`AlmaWidget` group `B1AA2200000000000000E001`):

```
		C1AA3300000000000000A001 /* PulseActivityAttributes.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = PulseActivityAttributes.swift; sourceTree = "<group>"; };
		C1AA3300000000000000A002 /* LiveActivityBridge.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LiveActivityBridge.swift; sourceTree = "<group>"; };
		C1AA3300000000000000A003 /* AlmaBridgeViewController.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AlmaBridgeViewController.swift; sourceTree = "<group>"; };
		C1AA3300000000000000A004 /* PulseLiveActivity.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = PulseLiveActivity.swift; sourceTree = "<group>"; };
```

**Groups** — add the three App-target file refs (`A001`, `A002`, `A003`) to the
existing **App** group's `children`, and add `A004` to the `AlmaWidget` group
`B1AA2200000000000000E001` (alongside `AlmaWidget.swift` etc.).

**App Sources phase** (`504EC3001FED79650016851F`) — add to `files`:

```
				C1AA3300000000000000B001 /* PulseActivityAttributes.swift in Sources */,
				C1AA3300000000000000B002 /* LiveActivityBridge.swift in Sources */,
				C1AA3300000000000000B003 /* AlmaBridgeViewController.swift in Sources */,
```

**Widget Sources phase** (`B1AA2200000000000000C001`) — add to `files`:

```
				C1AA3300000000000000B004 /* PulseLiveActivity.swift in Sources */,
				C1AA3300000000000000B005 /* PulseActivityAttributes.swift in Sources */,
```

### D. `Main.storyboard` — swap the root view controller's class

Change the Capacitor bridge scene's custom class from the stock class to the
subclass so the local plugin is registered on load:

```
	customClass="CAPBridgeViewController" customModule="Capacitor"
	→
	customClass="AlmaBridgeViewController"  customModule="App"
```

(Set `customModuleProvider="target"` if the storyboard element carries it; the App
module name is `App` per `PRODUCT_MODULE_NAME`.)

### E. `Info.plist` — `NSSupportsLiveActivities` in BOTH plists

Add to **both** `App/Info.plist` **and** `AlmaWidget/Info.plist`:

```xml
	<key>NSSupportsLiveActivities</key>
	<true/>
```

Without this key in the **App** plist, `Activity.request(...)` fails at runtime;
the widget plist needs it so the extension advertises Live Activity rendering.

### F. API-version caveats

- `Activity.request(attributes:contentState:pushType:)` (iOS 16.1) is deprecated on
  iOS 16.2+ in favour of `content: ActivityContent(...)`. `LiveActivityBridge.swift`
  uses `#available(iOS 16.2, *)` to pick the newer form and falls back to the 16.1
  form otherwise — both compile against the current SDK (the 16.1 form emits a
  deprecation warning only, not an error).
- `activity.update(_:)` / `activity.end(_:dismissalPolicy:)` similarly have 16.1 vs
  16.2 signatures; the bridge branches on 16.2 for both.
- Everything is additionally wrapped in `#if canImport(ActivityKit)` and
  `@available(iOS 16.1, *)`; on unsupported OS the bridge resolves `started:false` /
  `ended:false` and never traps.
