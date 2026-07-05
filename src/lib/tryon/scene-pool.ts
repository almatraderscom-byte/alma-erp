/**
 * Scene pool for on-model shots — poses + fully-Bangladeshi backgrounds.
 *
 * Owner's standing rule: the model pose must CHANGE on every run and the
 * background must always read as authentically Bangladeshi (never a generic
 * Western studio). A chain (adult shot → child shot → merge) picks ONE scene
 * up-front and reuses it across every step so the final composite has a single
 * consistent light/background; poses still vary per person.
 *
 * Everything here is deterministic data + a random picker — no LLM calls.
 */

export type BdScene = {
  id: string
  label: string
  /** Background + light description injected into generation prompts. */
  prompt: string
}

export const BD_SCENES: BdScene[] = [
  {
    id: 'old_dhaka_heritage',
    label: 'Old Dhaka heritage',
    prompt:
      'Background: an old Dhaka heritage courtyard — weathered brick arches, faded pastel plaster walls, warm afternoon sunlight raking across the stone floor. Authentic Bangladeshi heritage atmosphere.',
  },
  {
    id: 'rooftop_golden_hour',
    label: 'Dhaka rooftop golden hour',
    prompt:
      'Background: a Dhaka rooftop at golden hour — soft warm sunset light, distant city skyline and water tanks softly out of focus, warm haze. Authentic Bangladeshi urban rooftop mood.',
  },
  {
    id: 'village_courtyard',
    label: 'Village courtyard',
    prompt:
      'Background: a tidy Bangladeshi village homestead courtyard — swept earthen ground, tin-roofed house edge, banana and mango trees behind, soft morning light. Warm rural Bangladesh feel.',
  },
  {
    id: 'paddy_field_path',
    label: 'Paddy field path',
    prompt:
      'Background: a raised earthen path beside lush green Bangladeshi paddy fields, late-afternoon golden light, gentle breeze in the crops, soft depth of field. Iconic rural Bangladesh.',
  },
  {
    id: 'dhanmondi_lake',
    label: 'Lakeside park',
    prompt:
      'Background: a Dhaka lakeside park walkway (Dhanmondi-lake mood) — calm water, green trees, dappled natural light, relaxed urban Bangladeshi ambience.',
  },
  {
    id: 'heritage_red_brick',
    label: 'Red-brick heritage exterior',
    prompt:
      'Background: a red-brick Bangladeshi heritage building exterior with Mughal-style arches, warm evening light, clean and uncluttered. Dignified, premium Bangladeshi setting.',
  },
  {
    id: 'eid_home_interior',
    label: 'Festive home interior',
    prompt:
      'Background: a warm Bangladeshi home interior decorated tastefully for Eid — soft string lights, warm lamps, a hint of festive decor, cozy celebratory but uncluttered atmosphere.',
  },
  {
    id: 'tea_stall_street',
    label: 'Neighbourhood street',
    prompt:
      'Background: a clean Bangladeshi neighbourhood street in soft morning light — a tea stall and cycle-rickshaw softly blurred far behind, authentic everyday Dhaka life, subject fully separated from the background.',
  },
  {
    id: 'bd_studio_warm',
    label: 'BD studio (warm)',
    prompt:
      'Background: a professional Bangladeshi studio set — warm off-white seamless backdrop with a subtle jute/cane prop at the edge and soft golden key light, styled like a premium Dhaka fashion studio (not a cold Western studio).',
  },
  {
    id: 'mosque_courtyard_evening',
    label: 'Mosque courtyard evening',
    prompt:
      'Background: the outer courtyard of a beautiful Bangladeshi mosque at dusk — clean marble floor, elegant arches far behind, serene warm evening light. Respectful, premium Eid mood.',
  },
]

export const ADULT_POSES: string[] = [
  'standing relaxed and confident, weight on one leg, one hand loosely in pocket, full outfit visible',
  'mid-stride walking naturally toward camera, fabric in gentle motion',
  'three-quarter stance, one hand adjusting the cuff, looking slightly off-camera with a calm smile',
  'standing with arms loosely crossed, warm approachable expression, full-length framing',
  'seated elegantly on a low stool or step, garment arranged to show its drape and length',
  'turned slightly away then looking back over the shoulder toward camera, showing the garment silhouette',
]

export const CHILD_POSES: string[] = [
  'standing straight with a big natural smile, hands relaxed at the sides',
  'mid-laugh, slightly turned, natural childlike energy',
  'hands in pockets copying a grown-up pose, playful confident look',
  'walking a half-step ahead, looking back at the camera cheerfully',
  'arms crossed playfully with a proud grin',
]

export const PAIR_POSES: string[] = [
  'standing side by side, the adult\'s hand resting on the child\'s shoulder, both smiling at the camera',
  'walking together hand in hand toward the camera, natural mid-stride, both outfits fully visible',
  'the child standing a half-step in front with arms crossed playfully, the adult behind with a proud smile',
  'facing each other mid-laugh in a candid moment, both garments clearly visible to camera',
  'seated together on heritage steps, relaxed and warm, garments neatly arranged and fully visible',
  'the adult crouching to the child\'s height, both grinning at the camera, matching outfits side by side',
]

export const GROUP_POSES: string[] = [
  'the whole family standing together in a loose relaxed line, parents behind, children in front, everyone smiling naturally',
  'a candid walking shot — the family strolling together toward the camera, children slightly ahead',
  'parents standing close with each child in front of a parent, warm cohesive family portrait',
  'a seated family grouping on wide heritage steps, arranged naturally with every outfit fully visible',
]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export type PickedScene = {
  scene: BdScene
  adultPose: string
  childPose: string
  pairPose: string
  groupPose: string
}

/**
 * CS4 — owner-taste weighting (deterministic, never LLM-scored): each scene
 * carries a weight from ভালো/বাদ feedback. weight<=-3 disables the scene,
 * otherwise its selection chance scales by 2^weight. Pure: inject `rand` to
 * unit-test; empty weights = uniform (the original behaviour).
 */
export function pickSceneWeighted(
  weights: Record<string, number>,
  rand: () => number = Math.random,
): PickedScene {
  const entries = BD_SCENES.map((scene) => {
    const w = Number(weights[scene.id] ?? 0)
    return { scene, mult: w <= -3 ? 0 : Math.pow(2, Math.max(-2, Math.min(5, w))) }
  }).filter((e) => e.mult > 0)
  const pool = entries.length > 0 ? entries : BD_SCENES.map((scene) => ({ scene, mult: 1 }))
  const total = pool.reduce((sum, e) => sum + e.mult, 0)
  let roll = rand() * total
  let chosen = pool[pool.length - 1].scene
  for (const e of pool) {
    roll -= e.mult
    if (roll <= 0) { chosen = e.scene; break }
  }
  const pickWith = <T,>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))]
  return {
    scene: chosen,
    adultPose: pickWith(ADULT_POSES),
    childPose: pickWith(CHILD_POSES),
    pairPose: pickWith(PAIR_POSES),
    groupPose: pickWith(GROUP_POSES),
  }
}

/** Pick one random scene + poses for a run. Chains call this ONCE and carry the
 * result through every step so background/light stay consistent. */
export function pickScene(): PickedScene {
  return {
    scene: pick(BD_SCENES),
    adultPose: pick(ADULT_POSES),
    childPose: pick(CHILD_POSES),
    pairPose: pick(PAIR_POSES),
    groupPose: pick(GROUP_POSES),
  }
}

/** Serializable subset stored in job payloads. */
export type SceneRef = {
  sceneId: string
  scenePrompt: string
  adultPose: string
  childPose: string
  pairPose: string
  groupPose: string
}

export function toSceneRef(p: PickedScene): SceneRef {
  return {
    sceneId: p.scene.id,
    scenePrompt: p.scene.prompt,
    adultPose: p.adultPose,
    childPose: p.childPose,
    pairPose: p.pairPose,
    groupPose: p.groupPose,
  }
}
