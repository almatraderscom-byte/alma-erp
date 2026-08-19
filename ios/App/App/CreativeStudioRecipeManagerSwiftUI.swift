//
//  CreativeStudioRecipeManagerSwiftUI.swift
//  ALMA — native owner-scoped Brand Recipe management.
//

import SwiftUI
import Observation

private struct CSRMRecipe: Codable, Identifiable, Equatable {
    let id: String
    let brandProfileId: String
    let brandName: String
    let recipeKey: String
    let version: Int
    let name: String
    let sceneSubset: [String]
    let modelRoles: [String]
    let finishTheme: String
    let captionTone: String
    let aspectPack: [String]
    let musicVibe: String
    let qcLevel: String
    let spendCeilingBdt: Double
    let locked: Bool
    let lockedAt: String?
    let createdAt: String
    let updatedAt: String
}

private struct CSRMRecipesResponse: Decodable { let recipes: [CSRMRecipe] }
private struct CSRMRecipeResponse: Decodable { let recipe: CSRMRecipe }

@available(iOS 17.0, *)
@Observable
private final class CSRecipeManagerVM {
    struct Draft: Equatable {
        var name = ""
        var sceneSubset = ""
        var modelRoles = ["single"]
        var finishTheme = "default"
        var captionTone = "premium Bangla"
        var aspectPack = ["4:5"]
        var musicVibe = "premium"
        var qcLevel = "strict"
        var spendCeilingBdt = 0
    }

    let brandID: String
    let projectID: String
    let brandName: String
    let role: String
    var recipes: [CSRMRecipe] = []
    var selectedID: String?
    var currentRecipeID: String?
    var draft = Draft()
    var loading = false
    var busy = false
    var notice: String?

    var selected: CSRMRecipe? { recipes.first { $0.id == selectedID } }
    var owner: Bool { role == "owner" }
    var editable: Bool { owner && selected?.locked != true }

    init(brandID: String, projectID: String, brandName: String,
         currentRecipeID: String?, role: String) {
        self.brandID = brandID
        self.projectID = projectID
        self.brandName = brandName
        self.currentRecipeID = currentRecipeID
        self.role = role
    }

    func load(preferredID: String? = nil) async {
        loading = true
        defer { loading = false }
        do {
            let response: CSRMRecipesResponse = try await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/recipes",
                query: ["brandProfileId": brandID])
            recipes = response.recipes
            let resolved = preferredID
                ?? recipes.first(where: { $0.id == currentRecipeID })?.id
                ?? selectedID.flatMap { id in recipes.first(where: { $0.id == id })?.id }
                ?? recipes.first?.id
            select(resolved)
        } catch {
            notice = recipeMessage(error, fallback: "Recipe লোড করা যায়নি")
        }
    }

    func select(_ id: String?) {
        selectedID = id
        guard let recipe = recipes.first(where: { $0.id == id }) else {
            draft = Draft()
            return
        }
        draft = Draft(
            name: recipe.name,
            sceneSubset: recipe.sceneSubset.joined(separator: ", "),
            modelRoles: recipe.modelRoles,
            finishTheme: recipe.finishTheme,
            captionTone: recipe.captionTone,
            aspectPack: recipe.aspectPack,
            musicVibe: recipe.musicVibe,
            qcLevel: recipe.qcLevel,
            spendCeilingBdt: Int(recipe.spendCeilingBdt.rounded()))
    }

    func newRecipe() {
        guard !busy else { return }
        select(nil)
    }

    func save() async -> Bool {
        guard !busy else { return false }
        guard owner, draft.name.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
            notice = owner ? "Recipe নাম অন্তত ২ অক্ষর দিন" : "শুধু owner recipe পরিবর্তন করতে পারেন"
            return false
        }
        struct Payload: Encodable {
            let brandProfileId: String
            let brandName: String
            let name: String
            let sceneSubset: String
            let modelRoles: [String]
            let finishTheme: String
            let captionTone: String
            let aspectPack: [String]
            let musicVibe: String
            let qcLevel: String
            let spendCeilingBdt: Int
        }
        let wasCreating = selected == nil
        let body = Payload(
            brandProfileId: brandID,
            brandName: brandName,
            name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
            sceneSubset: draft.sceneSubset,
            modelRoles: draft.modelRoles,
            finishTheme: draft.finishTheme,
            captionTone: draft.captionTone,
            aspectPack: draft.aspectPack,
            musicVibe: draft.musicVibe,
            qcLevel: draft.qcLevel,
            spendCeilingBdt: draft.spendCeilingBdt)
        busy = true
        defer { busy = false }
        do {
            let response: CSRMRecipeResponse
            if let selected {
                guard !selected.locked else {
                    notice = "Locked recipe edit করতে নতুন version তৈরি করুন"
                    return false
                }
                response = try await AlmaAPI.shared.send(
                    "PATCH", "/api/assistant/creative-studio/recipes/\(selected.id)", body: body)
            } else {
                response = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/creative-studio/recipes", body: body)
            }
            await load(preferredID: response.recipe.id)
            notice = wasCreating ? "Recipe তৈরি হয়েছে" : "Recipe পরিবর্তন সেভ হয়েছে"
            return true
        } catch {
            notice = recipeMessage(error, fallback: "Recipe সেভ করা যায়নি")
            return false
        }
    }

    func act(_ action: String) async -> Bool {
        guard !busy, owner, let selected else { return false }
        struct Body: Encodable { let action: String }
        busy = true
        defer { busy = false }
        do {
            let response: CSRMRecipeResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/recipes/\(selected.id)",
                body: Body(action: action))
            await load(preferredID: response.recipe.id)
            notice = action == "lock" ? "Recipe version owner-locked" : "নতুন editable version তৈরি হয়েছে"
            return true
        } catch {
            notice = recipeMessage(error, fallback: "Recipe action সম্পন্ন হয়নি")
            return false
        }
    }

    func useSelected() async -> Bool {
        guard !busy, owner, let selected else { return false }
        struct Body: Encodable { let brandProfileId: String; let currentRecipeId: String }
        struct Response: Decodable { let project: CSProjectSummary }
        busy = true
        defer { busy = false }
        do {
            let _: Response = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/projects/\(projectID)",
                body: Body(brandProfileId: brandID, currentRecipeId: selected.id))
            currentRecipeID = selected.id
            notice = "এই project-এ \(selected.name) v\(selected.version) active"
            return true
        } catch {
            notice = recipeMessage(error, fallback: "Project recipe update হয়নি")
            return false
        }
    }

    private func recipeMessage(_ error: Error, fallback: String) -> String {
        if case let AlmaAPIError.http(_, body) = error,
           let message = CS.serverMessage(body) { return message }
        return fallback
    }
}

@available(iOS 17.0, *)
struct CSRecipeManagerScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var model: CSRecipeManagerVM
    @State private var confirmLock = false
    @State private var confirmSelect = false
    let onChanged: () -> Void

    init(brandID: String, projectID: String, brandName: String,
         currentRecipeID: String?, role: String, onChanged: @escaping () -> Void) {
        _model = State(initialValue: CSRecipeManagerVM(
            brandID: brandID, projectID: projectID, brandName: brandName,
            currentRecipeID: currentRecipeID, role: role))
        self.onChanged = onChanged
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentAuroraBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        accessCard
                        recipePicker
                        editor
                    }
                    .padding(16).padding(.bottom, 30)
                }
            }
            .navigationTitle("Brand Recipes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } } }
            .task { await model.load() }
            .overlay(alignment: .top) {
                if let notice = model.notice {
                    Text(notice).font(.caption.weight(.semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 13).padding(.vertical, 9)
                        .background(.black.opacity(0.78), in: Capsule()).padding(.top, 8)
                        .task { try? await Task.sleep(for: .seconds(3)); if model.notice == notice { model.notice = nil } }
                }
            }
            .alert("এই recipe version lock করবেন?", isPresented: $confirmLock) {
                Button("বাতিল", role: .cancel) {}
                Button("Owner lock") { Task { if await model.act("lock") { onChanged() } } }
                    .disabled(model.busy)
            } message: { Text("Lock হলে এই version আর edit হবে না; পরিবর্তনের জন্য নতুন version তৈরি করতে হবে।") }
            .alert("Project recipe পরিবর্তন করবেন?", isPresented: $confirmSelect) {
                Button("বাতিল", role: .cancel) {}
                Button("এই recipe ব্যবহার") { Task { if await model.useSelected() { onChanged() } } }
                    .disabled(model.busy)
            } message: { Text("পরবর্তী generation ও asset lineage এই exact recipe version ব্যবহার করবে।") }
        }
    }

    private var accessCard: some View {
        HStack(spacing: 10) {
            Image(systemName: model.owner ? "lock.open.fill" : "lock.fill").foregroundStyle(AgentPalette.coralLt)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.owner ? "Owner recipe controls" : "Read-only recipe library").font(.subheadline.weight(.bold))
                Text("Versioned · brand-scoped · asset lineage snapshot").font(.caption).foregroundStyle(AgentPalette(scheme).muted)
            }
        }.padding(14).csRecipeGlass(scheme)
    }

    private var recipePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Versions").font(.headline)
                Spacer()
                if model.owner {
                    Button("+ নতুন") { model.newRecipe() }
                        .font(.caption.weight(.bold))
                        .disabled(model.busy)
                }
            }
            if model.loading { ProgressView("Recipe লোড হচ্ছে…") }
            else if model.recipes.isEmpty { Text("এখনো কোনো recipe নেই").font(.caption) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.recipes) { recipe in
                        Button { model.select(recipe.id) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("\(recipe.name) · v\(recipe.version)").font(.caption.weight(.bold))
                                Text(recipe.locked ? "🔒 Locked" : "Draft").font(.caption2)
                            }.padding(.horizontal, 12).padding(.vertical, 9)
                                .background(model.selectedID == recipe.id ? AgentPalette.coral.opacity(0.28) : Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain).disabled(model.busy)
                    }
                }
            }
        }.padding(14).csRecipeGlass(scheme)
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text(model.selected == nil ? "নতুন Recipe" : "Recipe details").font(.headline)
                Spacer()
                if model.currentRecipeID == model.selectedID { Label("Active", systemImage: "checkmark.seal.fill").font(.caption).foregroundStyle(.green) }
            }
            if model.selected?.locked == true {
                Label("Owner-locked; নতুন version ছাড়া edit করা যাবে না", systemImage: "lock.fill")
                    .font(.caption).foregroundStyle(.green)
            }
            field("Recipe নাম", text: draftBinding(\.name))
            field("Scene subset — comma separated", text: draftBinding(\.sceneSubset))
            tokenGroup("Model roles", values: ["single", "father", "mother", "son", "daughter"], selected: \.modelRoles)
            tokenGroup("Aspect pack", values: ["1:1", "4:5", "9:16", "16:9"], selected: \.aspectPack)
            field("Finish theme", text: draftBinding(\.finishTheme))
            field("Caption tone", text: draftBinding(\.captionTone))
            field("Music vibe", text: draftBinding(\.musicVibe))
            Picker("QC level", selection: draftBinding(\.qcLevel)) {
                Text("Strict").tag("strict"); Text("Normal").tag("normal"); Text("Off").tag("off")
            }.pickerStyle(.segmented).disabled(!model.editable && model.selected != nil)
            Stepper("Spend ceiling ৳\(almaBn(model.draft.spendCeilingBdt))",
                    value: draftBinding(\.spendCeilingBdt), in: 0...100_000, step: 100)
                .disabled(!model.editable && model.selected != nil)
            actionButtons
        }.padding(14).csRecipeGlass(scheme)
    }

    private var actionButtons: some View {
        VStack(spacing: 9) {
            if model.owner && (model.selected == nil || model.selected?.locked != true) {
                Button { Task { if await model.save() { onChanged() } } } label: {
                    Label(model.selected == nil ? "Recipe তৈরি" : "পরিবর্তন সেভ", systemImage: "square.and.arrow.down.fill")
                        .frame(maxWidth: .infinity).padding(11)
                }.buttonStyle(.borderedProminent).tint(AgentPalette.coral)
                    .disabled(model.busy || model.draft.name.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
            }
            HStack {
                if model.owner, let selected = model.selected, !selected.locked {
                    Button("Owner lock") { confirmLock = true }.buttonStyle(.bordered).tint(.green)
                        .disabled(model.busy)
                }
                if model.owner, model.selected?.locked == true {
                    Button("নতুন version") { Task { if await model.act("new_version") { onChanged() } } }
                        .buttonStyle(.bordered).tint(AgentPalette.coral).disabled(model.busy)
                }
                if model.owner, model.selected != nil, model.currentRecipeID != model.selectedID {
                    Button("Project-এ ব্যবহার") { confirmSelect = true }.buttonStyle(.borderedProminent).tint(.blue)
                        .disabled(model.busy)
                }
            }.font(.caption.weight(.bold))
        }
    }

    private func field(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(AgentPalette(scheme).muted)
            TextField(label, text: text, axis: .vertical).textFieldStyle(.roundedBorder)
                .disabled(!model.editable && model.selected != nil)
        }
    }

    private func tokenGroup(_ label: String, values: [String],
                            selected keyPath: WritableKeyPath<CSRecipeManagerVM.Draft, [String]>) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(AgentPalette(scheme).muted)
            FlowLayout(spacing: 7) {
                ForEach(values, id: \.self) { value in
                    let active = model.draft[keyPath: keyPath].contains(value)
                    Button(value.capitalized) {
                        var draft = model.draft
                        var items = draft[keyPath: keyPath]
                        if active { items.removeAll { $0 == value } }
                        else { items.append(value) }
                        if !items.isEmpty { draft[keyPath: keyPath] = items; model.draft = draft }
                    }
                    .font(.caption2.weight(.bold)).foregroundStyle(active ? .white : AgentPalette(scheme).ink)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(active ? AgentPalette.coral : Color.white.opacity(0.07), in: Capsule())
                    .disabled(!model.editable && model.selected != nil)
                }
            }
        }
    }

    private func draftBinding<T>(_ keyPath: WritableKeyPath<CSRecipeManagerVM.Draft, T>) -> Binding<T> {
        Binding(get: { model.draft[keyPath: keyPath] }, set: { value in
            var draft = model.draft; draft[keyPath: keyPath] = value; model.draft = draft
        })
    }
}

private extension View {
    func csRecipeGlass(_ scheme: ColorScheme) -> some View {
        background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.035 : 0.27),
                        in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(.white.opacity(0.1), lineWidth: 1))
    }
}
