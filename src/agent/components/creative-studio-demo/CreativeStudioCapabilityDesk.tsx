'use client'

import { useState } from 'react'
import styles from './CreativeStudioEnterpriseDemo.module.css'
import { CreativeStudioWorkspaceShell } from './CreativeStudioWorkspaceShell'
import { StudioV2Icon, type StudioIconName } from './StudioV2Icon'
import type { StudioV3Navigate } from './studio-v3-navigation'
import { PROJECTS, REUSABLE_SYSTEMS } from './studio-v2-fixtures'
import {
  AVATARS,
  type CapabilityDeskId,
} from './studio-v3-fixtures'

type CreativeStudioCapabilityDeskProps = {
  desk: CapabilityDeskId
  onNavigate: StudioV3Navigate
}

const deskCopy: Record<
  CapabilityDeskId,
  {
    eyebrow: string
    title: string
    description: string
    icon: StudioIconName
  }
> = {
  projects: {
    eyebrow: 'CONTENT OS',
    title: 'Projects & folders',
    description: 'Brand-scoped project documents, legacy collections, ERP linkage and asset lineage.',
    icon: 'projects',
  },
  systems: {
    eyebrow: 'REUSABLE SYSTEMS',
    title: 'Recipes, models & avatars',
    description: 'Locked recipe versions, brand profiles, saved models and identity lifecycle.',
    icon: 'template',
  },
  review: {
    eyebrow: 'ENTERPRISE REVIEW',
    title: 'Review queue',
    description: 'Version-pinned decisions, immutable comments, change requests and role boundaries.',
    icon: 'review',
  },
  operations: {
    eyebrow: 'OWNER CONTROL PLANE',
    title: 'Operations',
    description: 'Distribution, attribution, retention, worker health, provider gates and spend policy.',
    icon: 'activity',
  },
  voice: {
    eyebrow: 'VOICE LAB',
    title: 'Voice & dubbing',
    description: 'Consent-pinned voices, narration, timed transcript and owner-only lifecycle.',
    icon: 'voice',
  },
  audio: {
    eyebrow: 'AUDIO LAB',
    title: 'Music, SFX & cleanup',
    description: 'Approved music, wish songs, owner voice, dubbing, voice cleanup and sound effects.',
    icon: 'audio',
  },
  campaign: {
    eyebrow: 'CAMPAIGN WORKFLOW',
    title: 'Campaign Pack',
    description: 'Deterministic manifest, two drafts, owner selection, staged outputs and safe retry.',
    icon: 'campaign',
  },
}

const deskNav: ReadonlyArray<{
  id: CapabilityDeskId
  label: string
  icon: StudioIconName
}> = [
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'systems', label: 'Recipes & models', icon: 'template' },
  { id: 'review', label: 'Review queue', icon: 'review' },
  { id: 'voice', label: 'Voice Lab', icon: 'voice' },
  { id: 'audio', label: 'Audio Lab', icon: 'audio' },
  { id: 'campaign', label: 'Campaign Pack', icon: 'campaign' },
  { id: 'operations', label: 'Operations', icon: 'activity' },
] as const

export function CreativeStudioCapabilityDesk({
  desk,
  onNavigate,
}: CreativeStudioCapabilityDeskProps) {
  const copy = deskCopy[desk]

  return (
    <CreativeStudioWorkspaceShell
      active="desk"
      description={copy.description}
      eyebrow={copy.eyebrow}
      icon={copy.icon}
      onNavigate={onNavigate}
      title={copy.title}
      actions={
        <span className={styles.v3DeskAccess}>
          <StudioV2Icon name="lock" size={14} />
          Owner fixture view
        </span>
      }
    >
      <div className={styles.v3DeskShell}>
        <aside aria-label="Studio enterprise workspaces" className={styles.v3DeskNav}>
          <div>
            <span className={styles.eyebrow}>STUDIO SYSTEM</span>
            <strong>ALMA Lifestyle</strong>
            <small>Owner · Creator · Reviewer</small>
          </div>
          <nav>
            {deskNav.map((item) => (
              <button
                aria-current={desk === item.id ? 'page' : undefined}
                className={desk === item.id ? styles.v3DeskNavActive : undefined}
                key={item.id}
                onClick={() => onNavigate({ id: 'desk', desk: item.id })}
                type="button"
              >
                <StudioV2Icon name={item.icon} size={17} />
                <span>{item.label}</span>
                <StudioV2Icon name="chevron-right" size={14} />
              </button>
            ))}
          </nav>
          <div className={styles.v3DeskSafety}>
            <StudioV2Icon name="lock" size={16} />
            <span>
              <strong>Safe presentation mode</strong>
              <small>No role, setting, delivery or provider state can be changed.</small>
            </span>
          </div>
        </aside>

        <section className={styles.v3DeskContent}>
          {desk === 'projects' && <ProjectsDesk onNavigate={onNavigate} />}
          {desk === 'systems' && <SystemsDesk onNavigate={onNavigate} />}
          {desk === 'review' && <ReviewDesk onNavigate={onNavigate} />}
          {desk === 'operations' && <OperationsDesk />}
          {desk === 'voice' && <VoiceDesk />}
          {desk === 'audio' && <AudioDesk />}
          {desk === 'campaign' && <CampaignDesk onNavigate={onNavigate} />}
        </section>
      </div>
    </CreativeStudioWorkspaceShell>
  )
}

function DeskHeading({
  eyebrow,
  title,
  description,
  aside,
}: {
  eyebrow: string
  title: string
  description: string
  aside?: string
}) {
  return (
    <header className={styles.v3DeskHeading}>
      <div>
        <span className={styles.eyebrow}>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {aside && <span>{aside}</span>}
    </header>
  )
}

function ProjectsDesk({ onNavigate }: { onNavigate: StudioV3Navigate }) {
  const [folder, setFolder] = useState('All active')
  const [search, setSearch] = useState('')
  const visible = PROJECTS.filter((project) =>
    `${project.title} ${project.collection} ${project.format}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  )

  return (
    <>
      <DeskHeading
        aside="18 projects · 4 folders"
        description="The project document is the hand-off point from creation into composition, review and delivery."
        eyebrow="PROJECT LIBRARY"
        title="Work stays attached to its business context"
      />

      <div className={styles.v3ProjectToolbar}>
        <label>
          <StudioV2Icon name="search" size={17} />
          <span className={styles.srOnly}>Search projects</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search title, collection or format"
            value={search}
          />
        </label>
        <button
          className={styles.secondaryButton}
          onClick={() => onNavigate({ id: 'project-setup', kind: 'longform' })}
          type="button"
        >
          <StudioV2Icon name="plus" size={16} />
          New empty project
        </button>
      </div>

      <div className={styles.v3ProjectDeskLayout}>
        <aside>
          <span className={styles.eyebrow}>FOLDERS</span>
          {[
            ['All active', '18'],
            ['Eid 2026', '7'],
            ['Everyday Edit', '5'],
            ['Brand stories', '3'],
            ['Legacy collection', '3'],
          ].map(([name, count]) => (
            <button
              aria-pressed={folder === name}
              className={folder === name ? styles.v3ProjectFolderActive : undefined}
              key={name}
              onClick={() => setFolder(name)}
              type="button"
            >
              <StudioV2Icon name={name === 'Legacy collection' ? 'archive' : 'folder'} size={16} />
              <span>{name}</span>
              <em>{count}</em>
            </button>
          ))}
          <div>
            <StudioV2Icon name="lock" size={14} />
            <span>
              <strong>Legacy is read-only</strong>
              <small>Attach without rewriting lineage.</small>
            </span>
          </div>
        </aside>

        <div className={styles.v3ProjectLedger}>
          {visible.map((project) => (
            <article key={project.id}>
              <span
                className={`${styles.v3ProjectPreview} ${styles[`projectArtwork_${project.preview}`]}`}
              >
                <i />
                <b />
                <em>{project.collection}</em>
              </span>
              <div>
                <span>{project.collection}</span>
                <h3>{project.title}</h3>
                <p>{project.format}</p>
                <dl>
                  <div>
                    <dt>Folder</dt>
                    <dd>{folder === 'All active' ? project.collection : folder}</dd>
                  </div>
                  <div>
                    <dt>ERP product</dt>
                    <dd>{project.id === 'coral-launch' ? 'AL-EID-042' : 'Pinned source'}</dd>
                  </div>
                  <div>
                    <dt>Recipe</dt>
                    <dd>Editorial Warm v7 · locked</dd>
                  </div>
                </dl>
              </div>
              <div>
                <span className={styles.v3ProjectDeskState}>{project.stateLabel}</span>
                <small>{project.activity}</small>
                <button
                  className={styles.primaryButton}
                  onClick={() => onNavigate({ id: 'editor', kind: project.kind, project })}
                  type="button"
                >
                  Open Project Editor
                  <StudioV2Icon name="chevron-right" size={15} />
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </>
  )
}

function SystemsDesk({ onNavigate }: { onNavigate: StudioV3Navigate }) {
  const [selectedRecipe, setSelectedRecipe] = useState<string>(REUSABLE_SYSTEMS[0].id)
  const [selectedAvatar, setSelectedAvatar] = useState(AVATARS[0].id)

  return (
    <>
      <DeskHeading
        aside="Versions pinned per job"
        description="Recipes and identities are reusable, but every request records the exact version, role and brand owner."
        eyebrow="BRAND SYSTEM"
        title="Approved creative systems"
      />

      <div className={styles.v3SystemsGrid}>
        <section>
          <header>
            <div>
              <span className={styles.eyebrow}>LOCKED RECIPES</span>
              <h3>Generation + finishing rules</h3>
            </div>
            <button disabled type="button">
              <StudioV2Icon name="plus" size={15} />
              New version
            </button>
          </header>
          <div className={styles.v3RecipeLedger}>
            {REUSABLE_SYSTEMS.map((system) => (
              <button
                aria-pressed={selectedRecipe === system.id}
                className={selectedRecipe === system.id ? styles.v3RecipeLedgerSelected : undefined}
                key={system.id}
                onClick={() => setSelectedRecipe(system.id)}
                type="button"
              >
                <span className={styles.v3SystemIcon}>
                  <StudioV2Icon
                    name={
                      system.kind === 'Recipe'
                        ? 'template'
                        : system.kind === 'Saved model'
                          ? 'projects'
                          : system.kind === 'Template'
                            ? 'video'
                            : 'campaign'
                    }
                    size={18}
                  />
                </span>
                <span>
                  <small>{system.kind}</small>
                  <strong>{system.name}</strong>
                  <em>{system.detail}</em>
                </span>
                <span>{system.meta}</span>
              </button>
            ))}
          </div>
          <div className={styles.v3RecipeFacts}>
            <div>
              <span>Brand profile</span>
              <strong>ALMA Lifestyle · coral / ivory / ink</strong>
            </div>
            <div>
              <span>Scope</span>
              <strong>Image · captions · finishing · safe zones</strong>
            </div>
            <div>
              <span>Lock</span>
              <strong>Owner only · v7 immutable</strong>
            </div>
          </div>
          <button
            className={styles.primaryButton}
            onClick={() => onNavigate({ id: 'image-lab' })}
            type="button"
          >
            Use in Image Lab
            <StudioV2Icon name="chevron-right" size={15} />
          </button>
        </section>

        <section>
          <header>
            <div>
              <span className={styles.eyebrow}>IDENTITY AVATARS</span>
              <h3>Saved models by family role</h3>
            </div>
            <button disabled type="button">
              <StudioV2Icon name="plus" size={15} />
              New
            </button>
          </header>
          <div className={styles.v3SystemAvatars}>
            {AVATARS.map((avatar) => (
              <button
                aria-pressed={selectedAvatar === avatar.id}
                className={selectedAvatar === avatar.id ? styles.v3SystemAvatarSelected : undefined}
                key={avatar.id}
                onClick={() => setSelectedAvatar(avatar.id)}
                type="button"
              >
                <span
                  className={`${styles.v3AvatarPortrait} ${styles[`v3Tone_${avatar.tone}`]}`}
                >
                  <i />
                  <b />
                  <em>{avatar.imageCount}</em>
                </span>
                <span>
                  <strong>{avatar.name}</strong>
                  <small>{avatar.role} · {avatar.version}</small>
                  <em>{avatar.status} · {avatar.owner}</em>
                </span>
              </button>
            ))}
          </div>
          <div className={styles.v3AvatarContract}>
            <StudioV2Icon name="lock" size={15} />
            <span>
              <strong>Existing Avatar contract</strong>
              <small>Up to 10 angles · optional free identity sheet · canonical portrait has a separate paid review.</small>
            </span>
          </div>
          <div className={styles.v3InlineActions}>
            <button
              className={styles.secondaryButton}
              onClick={() => onNavigate({ id: 'gallery', initialType: 'avatar' })}
              type="button"
            >
              View all avatars
            </button>
            <button
              className={styles.primaryButton}
              onClick={() => onNavigate({ id: 'image-lab', avatarId: selectedAvatar })}
              type="button"
            >
              Select for Image Lab
            </button>
          </div>
        </section>
      </div>
    </>
  )
}

function ReviewDesk({ onNavigate }: { onNavigate: StudioV3Navigate }) {
  const queue = [
    {
      id: 'review-01',
      title: 'Coral Panjabi Launch',
      version: 'Composition v12',
      state: 'Changes requested',
      detail: 'Caption safe-zone · Reviewer RN',
      time: '12 min ago',
    },
    {
      id: 'review-02',
      title: 'Father & Son · Draft B',
      version: 'Asset v6',
      state: 'Owner review',
      detail: 'Family fidelity · Creator SA',
      time: '27 min ago',
    },
    {
      id: 'review-03',
      title: 'Offer Promo · End card',
      version: 'Video v4',
      state: 'Revised',
      detail: 'CTA wording · Reviewer FA',
      time: '1 hr ago',
    },
  ] as const
  const [selectedId, setSelectedId] = useState<string>(queue[0].id)
  const [preview, setPreview] = useState(
    'Read-only fixture. No review event has been written.',
  )
  const selected = queue.find((item) => item.id === selectedId) ?? queue[0]

  return (
    <>
      <DeskHeading
        aside="3 waiting · append-only audit"
        description="A decision pins the exact asset/composition version; any later edit invalidates approval."
        eyebrow="VERSION-PINNED QUEUE"
        title="Review without losing lineage"
      />

      <div className={styles.v3ReviewLayout}>
        <div className={styles.v3ReviewQueue}>
          {queue.map((item) => (
            <button
              aria-pressed={selected.id === item.id}
              className={selected.id === item.id ? styles.v3ReviewSelected : undefined}
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              type="button"
            >
              <span>
                <StudioV2Icon name="review" size={17} />
              </span>
              <div>
                <small>{item.version}</small>
                <strong>{item.title}</strong>
                <em>{item.detail}</em>
              </div>
              <span>
                <strong>{item.state}</strong>
                <small>{item.time}</small>
              </span>
            </button>
          ))}
        </div>

        <article className={styles.v3ReviewDetail}>
          <header>
            <div>
              <span className={styles.eyebrow}>REVIEW TARGET</span>
              <h3>{selected.title}</h3>
              <p>{selected.version} · fingerprint 7A91-C2</p>
            </div>
            <span className={styles.v3ReviewRole}>Reviewer scope</span>
          </header>
          <div className={styles.v3ReviewPreview}>
            <span>ALMA</span>
            <i />
            <b />
            <em>Exact version preview</em>
          </div>
          <section>
            <span className={styles.eyebrow}>IMMUTABLE COMMENTS</span>
            <article>
              <span>RN</span>
              <div>
                <strong>Move the second caption above the platform safe zone.</strong>
                <small>00:08.2–00:10.6 · comment CMT-118 · 12 min ago</small>
              </div>
            </article>
            <article>
              <span>SA</span>
              <div>
                <strong>Revision v12 keeps the original source and updates captions only.</strong>
                <small>Transition: Changes requested → Revised · 4 min ago</small>
              </div>
            </article>
          </section>
          <div className={styles.v3ReviewAudit}>
            <StudioV2Icon name="lock" size={15} />
            <span>
              <strong>{preview}</strong>
              <small>Owner / Creator / Reviewer capability checks remain server-authoritative.</small>
            </span>
          </div>
          <div className={styles.v3InlineActions}>
            <button
              className={styles.secondaryButton}
              onClick={() => setPreview('Approval preview opened locally; no state transition was appended.')}
              type="button"
            >
              Preview decision
            </button>
            <button
              className={styles.primaryButton}
              onClick={() => onNavigate({ id: 'editor', kind: 'video' })}
              type="button"
            >
              Open exact version
            </button>
          </div>
        </article>
      </div>
    </>
  )
}

type OperationsTab = 'distribution' | 'performance' | 'retention' | 'workers' | 'policy'

function OperationsDesk() {
  const [tab, setTab] = useState<OperationsTab>('distribution')
  const tabs: ReadonlyArray<{
    id: OperationsTab
    label: string
    icon: StudioIconName
  }> = [
    { id: 'distribution', label: 'Distribution', icon: 'publish' },
    { id: 'performance', label: 'Performance', icon: 'analytics' },
    { id: 'retention', label: 'Retention', icon: 'archive' },
    { id: 'workers', label: 'Workers', icon: 'worker' },
    { id: 'policy', label: 'Roles & cost', icon: 'lock' },
  ]

  return (
    <>
      <DeskHeading
        aside="Owner-only controls"
        description="Operational truth is visible before an effect: dry run, exact version, health, spend and retention."
        eyebrow="CSE7 CONTROL PLANE"
        title="Govern the complete creative lifecycle"
      />
      <div className={styles.v3OperationsTabs} role="tablist" aria-label="Operations views">
        {tabs.map((item) => (
          <button
            aria-selected={tab === item.id}
            className={tab === item.id ? styles.v3OperationsTabActive : undefined}
            key={item.id}
            onClick={() => setTab(item.id)}
            role="tab"
            type="button"
          >
            <StudioV2Icon name={item.icon} size={16} />
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'distribution' && <DistributionPanel />}
      {tab === 'performance' && <PerformancePanel />}
      {tab === 'retention' && <RetentionPanel />}
      {tab === 'workers' && <WorkersPanel />}
      {tab === 'policy' && <PolicyPanel />}
    </>
  )
}

function DistributionPanel() {
  const [notice, setNotice] = useState('No delivery preview has been generated in this demo.')
  return (
    <section className={styles.v3OperationPanel}>
      <header>
        <div>
          <span className={styles.eyebrow}>DRY RUN FIRST</span>
          <h3>Meta delivery preview</h3>
          <p>Share preview, render/export and external publish are separate commands.</p>
        </div>
        <span className={styles.v3OperationSafe}>Live switch OFF</span>
      </header>
      <div className={styles.v3DistributionLayout}>
        <dl>
          <div><dt>Brand</dt><dd>ALMA Lifestyle</dd></div>
          <div><dt>Deliverable</dt><dd>Coral Panjabi Reel · v12</dd></div>
          <div><dt>Review pin</dt><dd>Approved · REV-782</dd></div>
          <div><dt>Campaign pack</dt><dd>PACK-EID-042 · selected draft B</dd></div>
          <div><dt>Fingerprint</dt><dd><code>7A91-C2-0F</code></dd></div>
          <div><dt>Idempotency</dt><dd><code>DLV-2026-118</code></dd></div>
        </dl>
        <div>
          <h4>Pre-dispatch gates</h4>
          {[
            'Exact asset/version still approved',
            'Owner role verified',
            'Caption and QC passed',
            'Live Meta switch remains disabled',
            'Ambiguous outcome never auto-retries',
          ].map((item, index) => (
            <span key={item}>
              <StudioV2Icon name={index < 3 ? 'check' : 'lock'} size={14} />
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className={styles.v3OperationNotice}>
        <StudioV2Icon name="lock" size={15} />
        <span>{notice}</span>
      </div>
      <div className={styles.v3InlineActions}>
        <button
          className={styles.secondaryButton}
          onClick={() => setNotice('Dry-run manifest previewed from fixtures only · ৳0 · no network or external effect.')}
          type="button"
        >
          Preview dry run · ৳0
        </button>
        <button className={styles.v3DisconnectedButton} disabled type="button">
          Schedule disconnected
        </button>
        <button className={styles.v3DisconnectedButton} disabled type="button">
          Publish disconnected
        </button>
      </div>
    </section>
  )
}

function PerformancePanel() {
  const values = [28, 42, 35, 58, 64, 51, 76, 69, 84, 71, 90, 82]
  return (
    <section className={styles.v3OperationPanel}>
      <header>
        <div>
          <span className={styles.eyebrow}>EXACT-VERSION ATTRIBUTION</span>
          <h3>Performance linked to delivery truth</h3>
          <p>Metrics append to the delivered asset/version; they never silently mutate a recipe.</p>
        </div>
        <span className={styles.v3OperationSafe}>7-day window</span>
      </header>
      <div className={styles.v3PerformanceStats}>
        <div><span>Assisted revenue</span><strong>৳184,300</strong><small>+18.4% from approved reels</small></div>
        <div><span>Qualified views</span><strong>48.2K</strong><small>Version-resolved</small></div>
        <div><span>Save rate</span><strong>6.8%</strong><small>Campaign Pack · Draft B</small></div>
        <div><span>Learning signal</span><strong>+0.12</strong><small>Suggestion only</small></div>
      </div>
      <div className={styles.v3PerformanceChart} aria-label="Fixture assisted revenue trend">
        {values.map((value, index) => (
          <span key={index} style={{ height: `${value}%` }}>
            <i />
          </span>
        ))}
      </div>
      <div className={styles.v3AttributionLedger}>
        {[
          ['Coral Panjabi Reel', 'DLV-118 · asset v12', '৳74.8K', '+0.08'],
          ['Father & Son Story', 'DLV-109 · asset v6', '৳63.1K', '+0.04'],
          ['Summer Catalog', 'DLV-097 · pack v3', '৳46.4K', 'hold'],
        ].map(([name, delivery, revenue, signal]) => (
          <div key={name}>
            <strong>{name}</strong>
            <span>{delivery}</span>
            <em>{revenue}</em>
            <code>{signal}</code>
          </div>
        ))}
      </div>
    </section>
  )
}

function RetentionPanel() {
  const [message, setMessage] = useState('Archive and fetch-back are read-only in the demo.')
  return (
    <section className={styles.v3OperationPanel}>
      <header>
        <div>
          <span className={styles.eyebrow}>RETENTION / ARCHIVE</span>
          <h3>Recoverable lifecycle, not silent deletion</h3>
          <p>Archive receipts preserve provenance, checksums and safe fetch-back.</p>
        </div>
        <span className={styles.v3OperationSafe}>12 due in 8 days</span>
      </header>
      <div className={styles.v3RetentionLedger}>
        {[
          ['Summer Catalog · raw drafts', '12 assets', 'Archive Jul 31', 'Eligible'],
          ['Eid 2025 · project archive', '86 assets', 'Archived', 'Receipt ARC-882'],
          ['Voice samples · revoked v1', '3 samples', 'Restricted', 'Owner only'],
        ].map(([name, count, date, state]) => (
          <article key={name}>
            <span><StudioV2Icon name="archive" size={17} /></span>
            <div><strong>{name}</strong><small>{count} · {date}</small></div>
            <em>{state}</em>
            <button
              onClick={() => setMessage(`${name} fetch-back preview opened. No archive object was read or changed.`)}
              type="button"
            >
              Inspect receipt
            </button>
          </article>
        ))}
      </div>
      <div className={styles.v3OperationNotice}>
        <StudioV2Icon name="lock" size={15} />
        <span>{message}</span>
      </div>
    </section>
  )
}

function WorkersPanel() {
  const workers = [
    ['image_gen', 'Healthy', '8 sec ago', '3 active'],
    ['video_gen', 'Healthy', '11 sec ago', '1 active'],
    ['video_edit', 'Healthy', '9 sec ago', '0 active'],
    ['audio_gen', 'Healthy', '14 sec ago', '0 active'],
    ['video_finish', 'Healthy', '7 sec ago', '1 active'],
    ['archive', 'Healthy', '19 sec ago', '0 active'],
  ]
  return (
    <section className={styles.v3OperationPanel}>
      <header>
        <div>
          <span className={styles.eyebrow}>WORKER + PROVIDER HEALTH</span>
          <h3>Queue state is not completion</h3>
          <p>Heartbeat, kill switch, balance and verified artifact state stay separate.</p>
        </div>
        <span className={styles.v3OperationSafe}>6 / 6 healthy</span>
      </header>
      <div className={styles.v3WorkersGrid}>
        {workers.map(([name, health, beat, jobs]) => (
          <article key={name}>
            <span><i /></span>
            <div><code>{name}</code><small>Heartbeat {beat}</small></div>
            <strong>{health}</strong>
            <em>{jobs}</em>
          </article>
        ))}
      </div>
      <div className={styles.v3ProviderLedger}>
        {[
          ['FASHN direct', 'Production', 'Balance healthy', 'Kill switch OFF'],
          ['Fal · FASHN 1.6', 'Commercial', '$14.80 available', 'Kill switch OFF'],
          ['Grok Imagine', 'Commercial', 'Canary 20%', 'Kill switch OFF'],
          ['IDM-VTON', 'Research only', 'Commercial blocked', 'Policy lock'],
          ['Veo 3.1 preview', 'Paid', 'Output truth required', 'Kill switch OFF'],
        ].map(([name, policy, balance, gate]) => (
          <div key={name}>
            <strong>{name}</strong>
            <span>{policy}</span>
            <em>{balance}</em>
            <code>{gate}</code>
          </div>
        ))}
      </div>
    </section>
  )
}

function PolicyPanel() {
  return (
    <section className={styles.v3OperationPanel}>
      <header>
        <div>
          <span className={styles.eyebrow}>ROLE / COST / SECURITY</span>
          <h3>Owner policy at the point of action</h3>
          <p>UI labels explain access; server capability checks remain authoritative.</p>
        </div>
        <span className={styles.v3OperationSafe}>0 policy alerts</span>
      </header>
      <div className={styles.v3PolicyGrid}>
        <section>
          <h4>Role assignments</h4>
          {[
            ['Maruf Billah', 'Owner', 'All brands · spend · publish · voice'],
            ['SA', 'Creator', 'ALMA Lifestyle · create / revise'],
            ['RN', 'Reviewer', 'Comment / request changes / approve'],
          ].map(([name, role, scope]) => (
            <div key={name}>
              <span>{name.slice(0, 2).toUpperCase()}</span>
              <div><strong>{name}</strong><small>{scope}</small></div>
              <em>{role}</em>
            </div>
          ))}
        </section>
        <section>
          <h4>Spend controls</h4>
          <dl>
            <div><dt>Today</dt><dd>৳420 / ৳2,500</dd></div>
            <div><dt>Single request confirm</dt><dd>Above ৳120</dd></div>
            <div><dt>Campaign hard cap</dt><dd>৳900</dd></div>
            <div><dt>Research providers</dt><dd>Commercial blocked</dd></div>
            <div><dt>External publish</dt><dd>Owner + live switch</dd></div>
          </dl>
        </section>
        <section>
          <h4>Security boundaries</h4>
          {[
            'Strict brand isolation on every Studio API',
            'Active consent version required for owner voice',
            'Fingerprint invalidates on target/provider/cost change',
            'Provider errors preserve diagnostics without false success',
            'Golden evaluation and child-garment cache are owner-only',
          ].map((item) => (
            <span key={item}>
              <StudioV2Icon name="check" size={14} />
              {item}
            </span>
          ))}
        </section>
      </div>
    </section>
  )
}

function VoiceDesk() {
  const [workflow, setWorkflow] = useState<'narration' | 'dubbing' | 'clone'>('narration')
  const [voice, setVoice] = useState('Owner voice · Active v3')
  const [text, setText] = useState('ঈদের নতুন গল্প—শান্ত আত্মবিশ্বাসে, ALMA-এর সাথে।')
  const [samples, setSamples] = useState(0)
  const [notice, setNotice] = useState('No synthesis, sample upload or voice lifecycle action has occurred.')

  return (
    <>
      <DeskHeading
        aside="Owner consent required"
        description="Approved voices are versioned, activatable and revocable. The Agent can reference only an active consent-pinned version."
        eyebrow="CSE5 VOICE"
        title="Consent before convenience"
      />

      <div className={styles.v3VoiceLayout}>
        <section>
          <div className={styles.v3VoiceTabs} role="tablist" aria-label="Voice workflows">
            {(
              [
                ['narration', 'Narration'],
                ['dubbing', 'Timed dubbing'],
                ['clone', 'Voice lifecycle'],
              ] as const
            ).map(([id, label]) => (
              <button
                aria-selected={workflow === id}
                className={workflow === id ? styles.v3VoiceTabActive : undefined}
                key={id}
                onClick={() => setWorkflow(id)}
                role="tab"
                type="button"
              >
                {label}
              </button>
            ))}
          </div>

          {workflow === 'clone' ? (
            <div className={styles.v3CloneLifecycle}>
              <header>
                <span className={styles.eyebrow}>OWNER-ONLY LIFECYCLE</span>
                <h3>Create an immutable voice version</h3>
                <p>Production accepts 1–3 consented samples, then records provider deletion/revocation.</p>
              </header>
              <div className={styles.v3CloneSteps}>
                {['Consent record', '1–3 owned samples', 'Build immutable version', 'Activate or revoke'].map(
                  (item, index) => (
                    <div key={item}>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <strong>{item}</strong>
                    </div>
                  ),
                )}
              </div>
              <div className={styles.v3SampleSlots}>
                {[1, 2, 3].map((item) => (
                  <button
                    aria-pressed={samples >= item}
                    key={item}
                    onClick={() => setSamples(samples >= item ? item - 1 : item)}
                    type="button"
                  >
                    <StudioV2Icon name={samples >= item ? 'check' : 'plus'} size={17} />
                    <span>{samples >= item ? `Fixture sample ${item}` : `Sample ${item}`}</span>
                  </button>
                ))}
              </div>
              <label className={styles.v3FinishToggle}>
                <input defaultChecked type="checkbox" />
                <span>
                  <strong>I own and consent to this voice use</strong>
                  <small>Demo acknowledgement only; no consent record is written.</small>
                </span>
              </label>
              <button className={styles.v3DisconnectedButton} disabled type="button">
                Voice build disconnected
              </button>
            </div>
          ) : (
            <div className={styles.v3VoiceComposer}>
              <label>
                <span>Approved voice version</span>
                <select onChange={(event) => setVoice(event.target.value)} value={voice}>
                  <option>Owner voice · Active v3</option>
                  <option>Brand narrator · Active v2</option>
                  <option disabled>Owner voice · Revoked v2</option>
                </select>
              </label>
              <div className={styles.v3VoiceIdentity}>
                <span><StudioV2Icon name="voice" size={20} /></span>
                <div>
                  <strong>{voice}</strong>
                  <small>Consent VC-2026-04 · owner-only · provider version immutable</small>
                </div>
                <em>Active</em>
              </div>
              <label className={styles.v3PromptField}>
                <span>
                  {workflow === 'dubbing' ? 'Timed transcript segment' : 'Narration script'}
                  <em>{workflow === 'dubbing' ? '00:01.2–00:04.8' : 'Bangla'}</em>
                </span>
                <textarea onChange={(event) => setText(event.target.value)} value={text} />
              </label>
              {workflow === 'dubbing' && (
                <div className={styles.v3DubbingTimeline}>
                  <span>00:00</span>
                  <div><i /><b style={{ width: '38%' }} /><em style={{ left: '18%' }} /></div>
                  <span>00:08</span>
                </div>
              )}
              <div className={styles.v3ComposerTrust}>
                <div><span>ESTIMATE</span><strong>৳18.00</strong><small>Provider confirmation required</small></div>
                <div><span>DESTINATION</span><strong>Voice track · v12</strong><small>Never auto-published</small></div>
              </div>
              <button
                className={styles.primaryButton}
                disabled={!text.trim()}
                onClick={() => setNotice(`${workflow} brief reviewed locally for ${voice}. No provider request exists.`)}
                type="button"
              >
                Review voice brief
              </button>
              <button className={styles.v3DisconnectedButton} disabled type="button">
                Synthesis disconnected
              </button>
            </div>
          )}
        </section>

        <aside>
          <span className={styles.eyebrow}>VOICE LIBRARY</span>
          {[
            ['Owner voice', 'Active v3', 'Consent VC-2026-04', 'Owner only'],
            ['Brand narrator', 'Active v2', 'Consent VC-2026-02', 'Campaigns'],
            ['Owner voice', 'Revoked v2', 'Provider deletion recorded', 'Blocked'],
          ].map(([name, version, consent, scope], index) => (
            <article key={`${name}-${version}`}>
              <span><StudioV2Icon name="voice" size={18} /></span>
              <div><strong>{name}</strong><small>{version} · {consent}</small></div>
              <em className={index === 2 ? styles.v3VoiceBlocked : undefined}>{scope}</em>
            </article>
          ))}
          <div className={styles.v3OperationNotice}>
            <StudioV2Icon name="lock" size={15} />
            <span>{notice}</span>
          </div>
        </aside>
      </div>
    </>
  )
}

function AudioDesk() {
  const workflows = [
    ['music', 'Music', 'Mood · 30 / 60 sec'],
    ['wish', 'Wish song', 'Birthday · anniversary · Eid'],
    ['owner', 'Owner voice', 'Consent-pinned TTS'],
    ['clean', 'Clean voice', 'Isolation + enhancement'],
    ['changer', 'Voice changer', 'Approved source only'],
    ['sfx', 'SFX', 'Prompt · duration · influence'],
  ] as const
  const [workflow, setWorkflow] = useState<(typeof workflows)[number][0]>('music')
  const [prompt, setPrompt] = useState('Warm celebratory percussion with a restrained modern pulse.')
  const [duration, setDuration] = useState(30)
  const [mood, setMood] = useState('Celebration')
  const [notice, setNotice] = useState('No audio generation, upload or provider request exists.')
  const estimate =
    workflow === 'clean' ? 0 : workflow === 'sfx' ? 6.25 : duration === 60 ? 34 : 18

  return (
    <>
      <DeskHeading
        aside="Cost before action"
        description="Every production audio path remains available with destination, consent, license and hard-cap context."
        eyebrow="CSE5 AUDIO"
        title="One governed sound workspace"
      />

      <div className={styles.v3AudioLayout}>
        <aside>
          {workflows.map(([id, label, detail]) => (
            <button
              aria-current={workflow === id ? 'page' : undefined}
              className={workflow === id ? styles.v3AudioModeActive : undefined}
              key={id}
              onClick={() => setWorkflow(id)}
              type="button"
            >
              <StudioV2Icon
                name={id === 'owner' || id === 'changer' || id === 'clean' ? 'voice' : 'audio'}
                size={17}
              />
              <span><strong>{label}</strong><small>{detail}</small></span>
              <StudioV2Icon name="chevron-right" size={14} />
            </button>
          ))}
        </aside>

        <section className={styles.v3AudioComposer}>
          <header>
            <span className={styles.eyebrow}>AUDIO BRIEF</span>
            <h3>{workflows.find(([id]) => id === workflow)?.[1]}</h3>
            <p>{workflows.find(([id]) => id === workflow)?.[2]}</p>
          </header>

          {workflow === 'wish' && (
            <div className={styles.v3ControlGrid}>
              <label><span>Occasion</span><select><option>Birthday</option><option>Anniversary</option><option>Eid</option></select></label>
              <label><span>Name</span><input defaultValue="Aariz" /></label>
            </div>
          )}
          {workflow === 'music' && (
            <div className={styles.v3OptionGroup}>
              <div className={styles.v3FieldLabel}><span>Mood</span><em>approved options</em></div>
              <div className={styles.v3OptionRow}>
                {['Celebration', 'Calm', 'Nasheed · vocal only'].map((item) => (
                  <button
                    aria-pressed={mood === item}
                    className={mood === item ? styles.v3SegmentActive : undefined}
                    key={item}
                    onClick={() => setMood(item)}
                    type="button"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}
          {workflow === 'owner' && (
            <div className={styles.v3VoiceIdentity}>
              <span><StudioV2Icon name="voice" size={20} /></span>
              <div><strong>Owner voice · Active v3</strong><small>Consent VC-2026-04 · immutable version</small></div>
              <em>Owner only</em>
            </div>
          )}
          {workflow === 'clean' && (
            <div className={styles.v3UploadBoundary}>
              <StudioV2Icon name="audio" size={22} />
              <strong>Owned voice note input</strong>
              <small>Upload is intentionally disconnected in this demo.</small>
            </div>
          )}
          <label className={styles.v3PromptField}>
            <span>{workflow === 'clean' ? 'Cleanup direction' : 'Prompt / script'}<em>required</em></span>
            <textarea onChange={(event) => setPrompt(event.target.value)} value={prompt} />
          </label>
          {(workflow === 'music' || workflow === 'wish' || workflow === 'sfx') && (
            <div className={styles.v3OptionGroup}>
              <div className={styles.v3FieldLabel}><span>Duration</span><em>hard option</em></div>
              <div className={styles.v3OptionRow}>
                {(workflow === 'sfx' ? [2, 5, 10] : [30, 60]).map((item) => (
                  <button
                    aria-pressed={duration === item}
                    className={duration === item ? styles.v3SegmentActive : undefined}
                    key={item}
                    onClick={() => setDuration(item)}
                    type="button"
                  >
                    {item}s
                  </button>
                ))}
              </div>
            </div>
          )}
          {workflow === 'sfx' && (
            <label>
              <span>Prompt influence · 65%</span>
              <input defaultValue="65" max="100" min="0" type="range" />
            </label>
          )}
          <div className={styles.v3ComposerTrust}>
            <div><span>ESTIMATE</span><strong>{estimate === 0 ? '৳0 local cleanup' : `৳${estimate.toFixed(2)}`}</strong><small>Hard cap checked server-side</small></div>
            <div><span>DESTINATION</span><strong>{workflow === 'sfx' ? 'SFX track' : workflow === 'music' ? 'Music track' : 'Voice track'}</strong><small>Project v12 · no publish</small></div>
          </div>
          <div className={styles.v3OperationNotice}>
            <StudioV2Icon name="lock" size={15} />
            <span>{notice}</span>
          </div>
          <button
            className={styles.primaryButton}
            disabled={!prompt.trim()}
            onClick={() => setNotice(`${workflow} brief reviewed locally at a maximum estimate of ৳${estimate.toFixed(2)}.`)}
            type="button"
          >
            Review audio brief
          </button>
          <button className={styles.v3DisconnectedButton} disabled type="button">
            Audio action disconnected
          </button>
        </section>

        <aside className={styles.v3MusicLibrary}>
          <span className={styles.eyebrow}>OWNER-APPROVED LIBRARY</span>
          {[
            ['Eid pulse', 'Celebration · 00:24', 'Licensed'],
            ['Quiet loom', 'Calm · 00:60', 'Owned'],
            ['Fabric movement', 'SFX · 00:02', 'Cleared'],
          ].map(([name, detail, status]) => (
            <article key={name}>
              <span><StudioV2Icon name="audio" size={16} /></span>
              <div><strong>{name}</strong><small>{detail}</small></div>
              <em>{status}</em>
            </article>
          ))}
        </aside>
      </div>
    </>
  )
}

function CampaignDesk({ onNavigate }: { onNavigate: StudioV3Navigate }) {
  const [selectedDraft, setSelectedDraft] = useState<'A' | 'B'>('B')
  const [stage, setStage] = useState('Preview manifest')
  const manifest = [
    ['Draft A', 'Image', '4:5', '1080 × 1350', 'Local preview'],
    ['Draft B', 'Image', '4:5', '1080 × 1350', 'Local preview'],
    ['Hero', 'Image', '4:5', '1080 × 1350', 'After selection'],
    ['Post', 'Image', '1:1', '1080 × 1080', 'After selection'],
    ['Story / reel cover', 'Image', '9:16', '1080 × 1920', 'After selection'],
    ['Reel', 'Video', '6 sec', '720p verified', 'Paid gate'],
  ] as const

  return (
    <>
      <DeskHeading
        aside="Hard cap ৳900"
        description="The manifest is deterministic before work; two drafts have isolated lineage and retry only the failed stage."
        eyebrow="CSE4 CAMPAIGN PACK"
        title="One brief, explicit deliverables"
      />

      <div className={styles.v3CampaignLayout}>
        <section className={styles.v3CampaignBrief}>
          <header>
            <span className={styles.eyebrow}>CAMPAIGN CONTEXT</span>
            <h3>Coral Panjabi · Eid 2026</h3>
            <p>ERP product AL-EID-042 · Editorial Warm v7 · ALMA Lifestyle</p>
          </header>
          <dl>
            <div><dt>Product</dt><dd>Coral Embroidered Panjabi</dd></div>
            <div><dt>Default model</dt><dd>Maruf Test · Avatar v4</dd></div>
            <div><dt>Brief</dt><dd>Quiet confidence for an Eid evening launch.</dd></div>
            <div><dt>Provider chain</dt><dd>FASHN image · Veo reel · local transforms</dd></div>
          </dl>
          <label className={styles.v3PromptField}>
            <span>Campaign direction <em>pinned to pack</em></span>
            <textarea defaultValue="Create a refined Eid launch set with faithful coral embroidery, family warmth and platform-safe Bengali captions." />
          </label>
          <div className={styles.v3ComposerTrust}>
            <div><span>ESTIMATE</span><strong>৳428.00</strong><small>Maximum before queue · hard cap ৳900</small></div>
            <div><span>LOCAL WORK</span><strong>4 derivative formats · ৳0</strong><small>Sharp transforms after owner selection</small></div>
          </div>
        </section>

        <section className={styles.v3CampaignManifest}>
          <header>
            <div><span className={styles.eyebrow}>DETERMINISTIC MANIFEST</span><h3>6 deliverables</h3></div>
            <span>Pack fingerprint <code>PK-42-7A91</code></span>
          </header>
          <div>
            {manifest.map(([name, type, aspect, resolution, gate], index) => (
              <article key={name}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div><strong>{name}</strong><small>{type} · {aspect}</small></div>
                <em>{resolution}</em>
                <code>{gate}</code>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.v3CampaignProgress}>
          <header>
            <div><span className={styles.eyebrow}>OWNER SELECTION</span><h3>Two isolated drafts</h3></div>
            <span>Stage: {stage}</span>
          </header>
          <div className={styles.v3DraftCompare}>
            {(['A', 'B'] as const).map((draft) => (
              <button
                aria-pressed={selectedDraft === draft}
                className={selectedDraft === draft ? styles.v3DraftSelected : undefined}
                key={draft}
                onClick={() => setSelectedDraft(draft)}
                type="button"
              >
                <span className={`${styles.v3DraftArtwork} ${draft === 'A' ? styles.v3Tone_sand : styles.v3Tone_coral}`}>
                  <i /><b /><em>Draft {draft}</em>
                </span>
                <span>
                  <strong>Draft {draft}</strong>
                  <small>{draft === 'A' ? 'Warm family light' : 'Editorial coral focus'}</small>
                  <em>Independent lineage · preview</em>
                </span>
              </button>
            ))}
          </div>
          <div className={styles.v3CampaignStages}>
            {[
              ['Manifest', 'Ready'],
              ['Drafts', 'Preview only'],
              ['Owner selection', `Draft ${selectedDraft}`],
              ['Derivatives', 'Not queued'],
              ['Reel', 'Paid gate'],
              ['Review', 'Waiting'],
            ].map(([name, state], index) => (
              <div key={name}>
                <span className={index < 3 ? styles.v3CampaignStageReady : undefined}>
                  {index < 3 ? <StudioV2Icon name="check" size={13} /> : index + 1}
                </span>
                <strong>{name}</strong>
                <small>{state}</small>
              </div>
            ))}
          </div>
          <div className={styles.v3OperationNotice}>
            <StudioV2Icon name="lock" size={15} />
            <span>{stage}. No campaign row, job or artifact has been created.</span>
          </div>
          <div className={styles.v3InlineActions}>
            <button
              className={styles.secondaryButton}
              onClick={() => setStage(`Draft ${selectedDraft} selected locally; selection fingerprint changed`)}
              type="button"
            >
              Preview selection
            </button>
            <button
              className={styles.primaryButton}
              onClick={() => onNavigate({ id: 'editor', kind: 'campaign' })}
              type="button"
            >
              Open composition plan
            </button>
            <button className={styles.v3DisconnectedButton} disabled type="button">
              Start pack disconnected
            </button>
          </div>
        </section>
      </div>
    </>
  )
}
