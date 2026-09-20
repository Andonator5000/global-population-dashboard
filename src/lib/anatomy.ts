/**
 * Human Anatomy artifacts (round 6, DATA_DECISIONS.md §55).
 *
 * data/anatomy/anatomy.json is produced by the `anatomy` ETL stage from
 * the editorial reference (etl/reference/anatomy.json, itself written by
 * etl/reference/build_anatomy.py). Nothing here is hand-typed: the page
 * renders what the stage validated and the images it downloaded through
 * the licence gate.
 */
import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface AnatomySource {
  title: string
  url: string
  publisher: string
}

export interface AnatomyImage {
  file: string
  width: number
  height: number
  title: string
  author: string
  licence: string
  creditLine: string
  sourcePage: string
}

export interface AnatomyLayer {
  id: string
  label: string | null
  system: string
  caption: string
  image: AnatomyImage
}

export interface AnatomySystem {
  id: string
  name: string
  summary: string
  description: string[]
  functions: string[]
  organs: string[]
  worksWith: { system: string; how: string }[]
  source: AnatomySource
}

export interface AnatomyOrgan {
  id: string
  name: string
  systems: string[]
  location: string
  description: string[]
  function: string
  facts: { label: string; value: string }[]
  source: AnatomySource
  /** 3-D alias patterns (round 12); resolved to node names by the build script. */
  mesh?: { match?: string[]; except?: string[]; layer?: string }
}

// --------------------------------------------------------------------------
// 3-D body models (round 12, DATA_DECISIONS.md §62). One registered free
// model per sex, cut into six layers ordered bone -> flesh by
// scripts/build-anatomy-models.mjs; every structure is a named node and
// structures-<sex>.json says what it is and which organ entry it opens.
// --------------------------------------------------------------------------

export type Sex = 'male' | 'female'
export type LayerId = 'skeleton' | 'nervous' | 'organs' | 'vessels' | 'muscles' | 'skin'

/** Bone to flesh. Index = depth on the peel control. */
export const LAYER_ORDER: LayerId[] = ['skeleton', 'nervous', 'organs', 'vessels', 'muscles', 'skin']

/** The layer at a depth on the peel control (the skin when out of range). */
export function layerAt(depth: number): LayerId {
  return LAYER_ORDER[depth] ?? 'skin'
}

export interface ModelLayer {
  id: LayerId
  label: string
  file: string
  bytes: number
  sha256: string
  structures: number
  triangles: number
  sourceTriangles: number
  coverage: 'full' | 'partial'
  note: string
  /** Extra files drawn with this layer under their own licence (round 12:
      the female stomach and oesophagus, fitted from the male model). */
  supplements?: ModelSupplement[]
}

export interface ModelSupplement {
  id: string
  layer: LayerId
  file: string
  bytes: number
  sha256: string
  structures: number
  triangles: number
  sourceTriangles: number
  licence: string
  licenceUrl: string
  note: string
  /** Round 13: what of the male layer was NOT fitted, and why. */
  omitted?: { what: string; count: number; why: string; examples?: string[] }[]
}

export interface ModelSource {
  id: string
  title: string
  author: string
  attribution: string | null
  licence: string
  licenceUrl: string
  sourcePage: string
  upstream?: { title: string; url: string; licence: string }[]
  doi?: string | null
  citationOverall?: string | null
  version?: string
  pinned?: { repository: string; commit: string }
  notice?: string
  /** Supplement sources only: why the model needed it. */
  why?: string
  /** Supplement sources only: how the fit was derived (numbers in the manifest). */
  fit?: unknown
  files: { file: string; url: string; bytes: number; sha256: string }[]
}

export interface ModelSex {
  sex: Sex
  source: ModelSource
  /** Sources of the layers' supplements, credited beside the model's own. */
  supplements?: ModelSource[]
  layers: ModelLayer[]
  omitted: { what: string; count: number; why: string }[]
  totalBytes: number
  structureCount: number
}

export interface ModelManifest {
  version: number
  note: string
  budgets: { layerBytes: number; sexBytes: number }
  layers: { id: LayerId; label: string; order: number }[]
  encoding: string[]
  sexes: Record<Sex, ModelSex>
}

export interface ModelStructure {
  node: string
  layer: LayerId
  name: string
  latin?: string | null
  derived?: string
  hraLabel?: string | null
  ontology?: string | null
  system: string | null
  group: string | null
  organ: string | null
  /** Set when the structure was fitted in from the other sex's model. */
  fitted?: string | null
  triangles: number
}

const modelCache = new Map<string, Promise<unknown>>()

function loadJson<T>(path: string): Promise<T> {
  let hit = modelCache.get(path) as Promise<T> | undefined
  if (!hit) {
    hit = fetch(`${DATA_BASE_URL}/${path}`).then((response) => {
      if (!response.ok) {
        modelCache.delete(path)
        throw new Error(`${path}: HTTP ${response.status}`)
      }
      return response.json() as Promise<T>
    })
    modelCache.set(path, hit)
  }
  return hit
}

export function loadModelManifest(): Promise<ModelManifest> {
  return loadJson<ModelManifest>('anatomy/models/manifest.json')
}

export function loadStructures(sex: Sex): Promise<ModelStructure[]> {
  return loadJson<{ sex: Sex; structures: ModelStructure[] }>(`anatomy/models/structures-${sex}.json`).then(
    (file) => file.structures,
  )
}

export function anatomyModelUrl(file: string): string {
  return `${DATA_BASE_URL}/${file}`
}

/** Which of the page's systems a whole layer stands for when nothing is picked. */
export const LAYER_SYSTEMS: Record<LayerId, string[]> = {
  skeleton: ['skeletal'],
  nervous: ['nervous'],
  organs: ['digestive', 'respiratory', 'urinary', 'reproductive', 'endocrine', 'lymphatic'],
  vessels: ['circulatory', 'lymphatic'],
  muscles: ['muscular'],
  skin: ['integumentary'],
}

export interface AnatomyCooperation {
  title: string
  systems: string[]
  text: string
}

export interface AnatomyFile {
  version: number
  note: string
  layers: AnatomyLayer[]
  figures: AnatomyLayer[]
  systems: AnatomySystem[]
  organs: AnatomyOrgan[]
  cooperation: AnatomyCooperation[]
}

let pending: Promise<AnatomyFile> | null = null

function load(): Promise<AnatomyFile> {
  if (!pending) {
    pending = fetch(`${DATA_BASE_URL}/anatomy/anatomy.json`).then((response) => {
      if (!response.ok) {
        pending = null
        throw new Error(`anatomy/anatomy.json: HTTP ${response.status}`)
      }
      return response.json() as Promise<AnatomyFile>
    })
  }
  return pending
}

export function useAnatomy(): AsyncState<AnatomyFile> {
  const [state, setState] = useState<AsyncState<AnatomyFile>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    load()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

export function anatomyImageUrl(image: AnatomyImage): string {
  return `${DATA_BASE_URL}/${image.file}`
}

// --------------------------------------------------------------------------
// Round 13: label sets, structure descriptions and the rendered diagrams.
// --------------------------------------------------------------------------

/** The stage's normalisation, mirrored exactly (.scratch/anatomy-desc-notes.md). */
const WIKI_SIDE = /\s*\((?:left|right)(?:\s*,\s*[^)]*)?\)\s*$/i
const WIKI_PART = /\s*[—–-]\s*part\s+\S+\s*$/i
export function normaliseStructureName(name: string | null | undefined): string {
  let text = String(name ?? '').split(/\s+/).filter(Boolean).join(' ')
  let previous: string | null = null
  while (previous !== text) {
    previous = text
    text = text.replace(WIKI_SIDE, '').replace(WIKI_PART, '').trim()
  }
  return text
}

/**
 * Display form of a model name: the HRA writes "Left femur", Z-Anatomy
 * "Femur (left)"; both sexes read the same way on labels, cards and in the
 * index. The Wikipedia key is the ORIGINAL name (the stage keys by it).
 */
export function displayName(name: string): string {
  const m = name.match(/^(Left|Right) (.+)$/)
  if (!m) return name
  const rest = m[2]!
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)} (${m[1]!.toLowerCase()})`
}

/**
 * The label-group name of a structure: display form, side and part stripped;
 * the HRA's bone TISSUE nodes ("Pubis spongy bone", "Ilium compact bone")
 * merge into the bone ("Pubis", "Ilium") so the pelvis is labelled by bone.
 */
export function groupNameOf(name: string): string {
  return normaliseStructureName(displayName(name)).replace(/ (compact|spongy) bone$/i, '')
}

/** Which side a model name carries, if any. */
export function structureSide(name: string): 'left' | 'right' | null {
  name = displayName(name)
  const m = name.match(/\((left|right)(?:\s*,\s*[^)]*)?\)\s*$/i)
  const side = m?.[1]?.toLowerCase()
  return side === 'left' || side === 'right' ? side : null
}

/**
 * A label group: every node of a layer that shares one normalised name
 * ("Humerus" for Humerus (left) and Humerus (right); "Extensor digitorum"
 * for its part slips). The viewer anchors a label at the group's box
 * centre, or one per side when the sides sit far apart.
 */
export interface LabelGroup {
  key: string
  layer: LayerId
  name: string
  nodes: ModelStructure[]
  organ: string | null
  system: string | null
  fitted: boolean
}

export function labelGroups(structures: ModelStructure[], layer: LayerId): LabelGroup[] {
  const groups = new Map<string, LabelGroup>()
  for (const s of structures) {
    if (s.layer !== layer) continue
    const name = groupNameOf(s.name)
    const key = `${layer}:${name}`
    let g = groups.get(key)
    if (!g) {
      g = { key, layer, name, nodes: [], organ: s.organ ?? null, system: s.system ?? null, fitted: Boolean(s.fitted) }
      groups.set(key, g)
    }
    g.nodes.push(s)
    if (!g.organ && s.organ) g.organ = s.organ
    if (!s.fitted) g.fitted = g.fitted && false
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export interface WikiEntry {
  title: string | null
  url?: string
  extract?: string
  resolvedBy?: string
  scope?: 'exact' | 'broader'
  reason?: string
  latin?: string | null
  systems?: string[]
  layers?: string[]
  count?: number
  uberon?: string
}

export interface WikiFile {
  version: number
  generated: string
  source: { title: string; url: string; licence: string; licenceUrl: string; note?: string }
  counts?: Record<string, unknown>
  structures: Record<string, WikiEntry>
}

export function loadStructureWiki(): Promise<WikiFile> {
  return loadJson<WikiFile>('anatomy/structures-wiki.json')
}

/** The rendered diagrams (scripts/render-anatomy-diagrams.mjs). */
export type DiagramView = 'front' | 'back'

/** [visible pixels, centroid x, centroid y, bbox x0, y0, x1, y1] in image pixels. */
export type DiagramAnchor = [number, number, number, number, number, number, number]

export interface DiagramImage {
  layer: LayerId
  view: DiagramView
  file: string
  width: number
  height: number
  bytes: number
  sha256: string
}

export interface DiagramSex {
  box: { min: number[]; max: number[] }
  images: DiagramImage[]
  anchors: Record<string, Record<string, DiagramAnchor>>
  modelFiles: { file: string; sha256: string; bytes: number }[]
  totalBytes: number
}

export interface DiagramsFile {
  version: number
  heightPx: number
  views: DiagramView[]
  layers: LayerId[]
  note: string
  budgets: { imageBytes: number; sexBytes: number }
  sexes: Record<Sex, DiagramSex>
}

export function loadDiagrams(): Promise<DiagramsFile> {
  return loadJson<DiagramsFile>('anatomy/diagrams/diagrams.json')
}

/** Human-readable layer description for the coverage note. */
export function isFitted(structure: ModelStructure | null | undefined): boolean {
  return Boolean(structure?.fitted)
}

/**
 * Curated label priority per layer (round 13). Tier 0: the major parts a
 * reader expects named at rest; tier 2: a sub-part (a tissue, a ligament,
 * a segment, a branch) that must never be labelled ahead of the structure
 * it belongs to; tier 1: everything else. An organ-entry structure that is
 * not otherwise a sub-part is tier 0 in the organs layer.
 */
const SUBPART = /spongy bone|compact bone|cortex|medulla|trabecul|ligament|membrane|cartilage|capsule|impression|surface of|segment|part of|branch|tendon|fascia|bursa|sheath|septum|aponeurosis|retinaculum|meniscus|labrum|disc|pulposus|process|tubercle|fossa|notch|sulcus|gyrus|nucleus|tract|fasciculus|peduncle|papilla|calyx|pyramid|column|hilum|lobule|lobe of|duct|sinus|valve|leaflet|papillary|ostium|fimbria|ampulla|isthmus|infundibulum|fundus|body of|neck of|head of|tail of|wall of|os$|junction|orifice|plate|perionyx|region of|triangle|groove|fold|foveola|border/i
const PRIORITY: Record<LayerId, RegExp> = {
  skeleton: /^(skull|cranium|frontal bone|parietal bone|occipital bone|temporal bone|mandible|maxilla|zygomatic bone|nasal bone|hyoid bone|vertebra [ctl]\d+|atlas|axis|cervical vertebra|thoracic vertebra|lumbar vertebra|vertebral column|clavicle|scapula|sternum|manubrium of sternum|body of sternum|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) rib|humerus|radius|ulna|carpal bones|(scaphoid|lunate|triquetrum|pisiform|trapezium|trapezoid|capitate|hamate) bone|(first|second|third|fourth|fifth) metacarpal bone|hip bone|ilium|ischium|pubis|pelvis|sacrum|fused sacrum|coccyx|femur|patella|tibia|fibula|talus|calcaneus|navicular bone|cuboid bone|(medial|intermediate|lateral) cuneiform bone|(first|second|third|fourth|fifth) metatarsal bone)$/i,
  muscles: /^(deltoid|pectoralis major|pectoralis minor|biceps brachii|triceps brachii|brachialis|brachioradialis|rectus abdominis|external abdominal oblique|internal abdominal oblique|transversus abdominis|latissimus dorsi|trapezius|erector spinae|gluteus maximus|gluteus medius|quadriceps femoris|rectus femoris|vastus lateralis|vastus medialis|sartorius|biceps femoris|semitendinosus|semimembranosus|adductor magnus|adductor longus|gracilis|iliopsoas|psoas major|gastrocnemius|soleus|tibialis anterior|sternocleidomastoid|masseter|temporalis|orbicularis oculi|orbicularis oris|diaphragm|serratus anterior|infraspinatus|supraspinatus|teres major|platysma|flexor digitorum superficialis|extensor digitorum|tensor fasciae latae|iliotibial tract)( muscle)?$/i,
  organs: /^(liver|stomach|pancreas|spleen|gallbladder|small intestine|duodenum|jejunum|ileum|large intestine|caecum|ascending colon|transverse colon|descending colon|sigmoid colon|rectum|vermiform appendix|oesophagus|trachea|(superior|middle|inferior) lobe of (left|right) lung|left main bronchus|right main bronchus|kidney|urinary bladder|ureter|urethra|uterus|body of uterus|ovary|vagina|prostate|testis|thyroid gland|suprarenal gland|adenohypophysis|thymus|tongue|pharynx|larynx|thyroid cartilage|epiglottis|parotid gland|submandibular gland|mammary lobes|left thymus lobe|right thymus lobe)$/i,
  vessels: /^(heart|left ventricle|right ventricle|left atrium|right atrium|heart left ventricle|heart right ventricle|left cardiac atrium|right cardiac atrium|ascending aorta|arch of aorta|aortic arch|thoracic aorta|abdominal aorta|descending aorta|pulmonary trunk|(left|right) pulmonary artery|superior vena cava|inferior vena cava|brachiocephalic trunk|brachiocephalic artery|(common|internal|external) carotid artery|(internal|external) jugular vein|subclavian artery|subclavian vein|axillary artery|brachial artery|radial artery|ulnar artery|cephalic vein|basilic vein|common iliac artery|external iliac artery|internal iliac artery|common iliac vein|femoral artery|femoral vein|popliteal artery|great saphenous vein|anterior tibial artery|posterior tibial artery|renal artery|renal vein|hepatic portal vein|celiac trunk|coeliac trunk|superior mesenteric artery|inferior mesenteric artery|spleen|thymus|thoracic duct|azygos vein|(left|right) coronary artery)$/i,
  nervous: /^(brain|cerebrum|cerebellum|brainstem|medulla oblongata|pons|midbrain|thalamus|hypothalamus|corpus callosum|spinal cord|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) (thoracic|lumbar|sacral) spinal cord segment|c\d segment of cervical spinal cord|brachial plexus|lumbar plexus|sacral plexus|sciatic nerve|tibial nerve|common fibular nerve|femoral nerve|obturator nerve|median nerve|ulnar nerve|radial nerve|musculocutaneous nerve|axillary nerve|vagus nerve( \(x\))?|phrenic nerve|trigeminal nerve( \(v\))?|facial nerve( \(vii\))?|optic nerve( \(ii\))?|sympathetic trunk|cauda equina|intercostal nerves|eyeball|eye|retina|cochlea|frontal lobe|parietal lobe|temporal lobe|occipital lobe|superior frontal gyrus|precentral gyrus|postcentral gyrus|white matter of forebrain|lateral hemisphere of cerebellum)$/i,
  skin: /^(head|face|neck|thorax|abdomen|back|(frontal|parietal|occipital|temporal|orbital|nasal|oral|mental|buccal|zygomatic|auricular|pectoral|mammary|presternal|epigastric|umbilical|hypogastric|inguinal|gluteal|lumbar|sacral|deltoid|scapular|vertebral|infrascapular|interscapular|hip|urogenital|anal) region|(anterior|posterior|lateral) region of (neck|thorax|abdomen|arm|forearm|thigh|leg|knee|elbow|wrist|ankle)|cubital fossa|popliteal fossa|femoral triangle|axilla|dorsum of hand|palm|dorsum of foot|sole|heel region|hairs of head|skin|skin of body)$/i,
}

/** Z-Anatomy splits the big muscles into heads and parts ("Sternocostal head of
    pectoralis major muscle"): a part that NAMES a priority muscle ranks with it. */
const MUSCLE_CONTAINS = /deltoid|pectoralis major|biceps brachii|triceps brachii|rectus abdominis|external abdominal oblique|latissimus dorsi|trapezius|gluteus maximus|quadriceps femoris|rectus femoris|vastus lateralis|biceps femoris|semitendinosus|semimembranosus|gastrocnemius|soleus|tibialis anterior|sternocleidomastoid|masseter|temporalis|diaphragm|serratus anterior|adductor magnus|iliopsoas|psoas major|erector spinae|brachialis|brachioradialis/i

export function labelPriority(layer: LayerId, name: string, organ: string | null): number {
  const n = name.toLowerCase().replace(/\s*\((left|right|left\/right)\)\s*$/i, '')
  if (PRIORITY[layer].test(n)) return 0
  if (layer === 'muscles' && MUSCLE_CONTAINS.test(n) && !/tendon|fascia|bursa|sheath|aponeurosis/.test(n)) return 0
  if (layer === 'organs' && organ && !SUBPART.test(n)) return 0
  if (SUBPART.test(n)) return 2
  return 1
}
