// Build the 3-D anatomy models (round 12, DATA_DECISIONS.md §62 draft in
// .scratch/decisions-r12-anatomy.md).
//
// Two free whole-body sources, ONE per sex, so every layer of a sex sits in
// the same model space (same pose, same scale) and the layers register:
//
//   male    Z-Anatomy (CC BY-SA 4.0, after BodyParts3D / DBCLS CC BY-SA 2.1 JP),
//           as the Draco GLB export shipped by Anatria3D (github.com/Nurkan1/
//           Anatria-3D, public/anatomy/*_male.glb, pinned to one commit).
//           Node names are Terminologia Anatomica 2 English terms.
//   female  NIH HuBMAP Human Reference Atlas, "3D Reference Organ Set for
//           Female" v1.5 united body (CC BY 4.0), one GLB straight from the
//           HRA CDN. Node names are the HRA's own (VH_F_*), with the HRA label
//           and ontology id kept from each node's extras.
//
// The script downloads each pinned source (cached under .cache/anatomy3d/),
// records sha256/bytes/licence/author/source page, groups the structures into
// six LAYERS ordered bone -> flesh (skeleton, nervous, organs, vessels,
// muscles, skin), keeps EVERY structure as a named node, simplifies each layer
// to a byte budget (meshoptimizer), compresses it (EXT_meshopt_compression +
// KHR_mesh_quantization; decoded in the browser by three's self-contained
// meshopt decoder — nothing fetched from a third-party CDN), resolves the
// editorial organ aliases in etl/reference/anatomy.json (`mesh` per organ) to
// node names, and writes:
//
//   data/anatomy/models/<sex>-<layer>.glb
//   data/anatomy/models/structures-<sex>.json   every node: name, system, organ
//   data/anatomy/models/manifest.json           sources, licences, layers, bytes
//   data/anatomy/models/NOTICE-male.txt         the male atlas's attribution chain
//
// Idempotent: re-running re-uses the cached downloads and rewrites the same
// outputs. Budgets: <= 6 MB per layer file, <= 28 MB per sex; the script fails
// if either is exceeded, and scripts/check-anatomy.mjs proves it again on the
// committed files. Run with a large heap: the female source is a 211 MB GLB.
//
//   node --max-old-space-size=8192 scripts/build-anatomy-models.mjs
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Document, NodeIO, getBounds } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, dedup, dequantize, flatten, meshopt, prune, simplify, unpartition, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, '.cache', 'anatomy3d')
const OUT = join(ROOT, 'data', 'anatomy', 'models')
const REFERENCE = join(ROOT, 'etl', 'reference', 'anatomy.json')
const REPORT = join(ROOT, '.scratch', 'anatomy-alias-report.md')

const LAYER_BUDGET = 6_000_000
const SEX_BUDGET = 28_000_000

// --------------------------------------------------------------------------
// Sources (pinned)
// --------------------------------------------------------------------------
const ANATRIA_COMMIT = '949ac80cc9763539afc48e60b5246132f00468db'
const ANATRIA_RAW = `https://raw.githubusercontent.com/Nurkan1/Anatria-3D/${ANATRIA_COMMIT}/public/anatomy/`
const ANATRIA_PAGE = `https://github.com/Nurkan1/Anatria-3D/tree/${ANATRIA_COMMIT}/public/anatomy`
const MALE_FILES = [
  'skeletal_male.glb', 'articular_male.glb', 'nervous_male.glb', 'visceral_male.glb',
  'digestive_male.glb', 'respiratory_male.glb', 'renal_male.glb', 'reproductive_male.glb',
  'endocrine_male.glb', 'cardiovascular_male.glb', 'lymphatic_male.glb', 'muscular_male.glb',
  'regional_male.glb',
]
const HRA_VERSION = 'v1.5'
const HRA_BASE = `https://cdn.humanatlas.io/digital-objects/ref-organ/united-female/${HRA_VERSION}/`
const HRA_GLB = `${HRA_BASE}assets/3d-vh-f-united.glb`
const HRA_META = `${HRA_BASE}metadata.json`
const HRA_PAGE = 'https://humanatlas.io/3d-reference-library'

// Bone -> flesh. `order` is the peel order the viewer uses; `ratio` the
// simplification target (fraction of triangles kept) per sex; `error` the
// meshoptimizer error bound as a fraction of each mesh's radius.
const LAYERS = [
  { id: 'skeleton', label: 'Skeleton', ratio: { male: 0.55, female: 0.6 }, error: 0.01 },
  { id: 'nervous', label: 'Brain and nerves', ratio: { male: 0.3, female: 0.3 }, error: 0.03 },
  { id: 'organs', label: 'Organs and glands', ratio: { male: 0.6, female: 0.35 }, error: 0.03 },
  { id: 'vessels', label: 'Heart, vessels and lymph', ratio: { male: 0.3, female: 0.45 }, error: 0.02 },
  { id: 'muscles', label: 'Muscles', ratio: { male: 0.35, female: 0.6 }, error: 0.015 },
  { id: 'skin', label: 'Skin', ratio: { male: 0.8, female: 0.5 }, error: 0.01 },
]

// Male: which Anatria files feed which layer, in order. A node name claimed
// by an earlier layer is skipped later (teeth are in skeletal AND digestive;
// the intervertebral discs in skeletal AND articular).
const MALE_LAYER_FILES = {
  skeleton: ['skeletal_male.glb', 'articular_male.glb'],
  nervous: ['nervous_male.glb'],
  organs: ['visceral_male.glb', 'digestive_male.glb', 'respiratory_male.glb', 'renal_male.glb',
    'reproductive_male.glb', 'endocrine_male.glb'],
  vessels: ['cardiovascular_male.glb', 'lymphatic_male.glb'],
  muscles: ['muscular_male.glb'],
  skin: ['regional_male.glb'],
}
// Anatria's per-file system -> this site's system ids.
const MALE_SYSTEM = {
  skeletal: 'skeletal', articular: 'skeletal', nervous: 'nervous', visceral: 'digestive',
  digestive: 'digestive', respiratory: 'respiratory', renal: 'urinary', reproductive: 'reproductive',
  endocrine: 'endocrine', cardiovascular: 'circulatory', lymphatic: 'lymphatic', muscular: 'muscular',
  regional: 'integumentary',
}
// Z-Anatomy collections left out, with the reason recorded in the manifest.
const MALE_OMIT_PATHS = {
  'Muscular insertions': 'attachment footprints painted on bone (origin/insertion patches), not muscles',
  'stray duplicate': 'a copy of a mesh that Anatria\'s manifest files under another system (the nervous export carries 278 muscles); kept once, in its own layer',
  unnamed: 'a node whose name is punctuation only ("????????" and "?x" in cardiovascular_male.glb)',
}

// Female: HRA system group (depth-1 node) -> layer; a "system:group" entry
// takes one depth-2 group only.
const FEMALE_LAYER_GROUPS = {
  skeleton: ['VH_F_skeletal_system'],
  nervous: ['VH_F_nervous_system'],
  organs: ['VH_F_digestive_system', 'VH_F_urinary_system', 'VH_F_respiratory_system',
    'VH_F_lymphatic_system', 'VH_F_reproductive_system', 'VH_F_integumentary_system:VH_F_mammary_gland'],
  vessels: ['VH_F_circulatory_system'],
  muscles: ['VH_F_muscular_system'],
  skin: ['VH_F_integumentary_system:VH_F_skin'],
}
const FEMALE_SYSTEM = {
  VH_F_skeletal_system: 'skeletal', VH_F_nervous_system: 'nervous', VH_F_digestive_system: 'digestive',
  VH_F_urinary_system: 'urinary', VH_F_respiratory_system: 'respiratory', VH_F_lymphatic_system: 'lymphatic',
  VH_F_reproductive_system: 'reproductive', VH_F_integumentary_system: 'integumentary',
  VH_F_circulatory_system: 'circulatory', VH_F_muscular_system: 'muscular',
}
const FEMALE_OMIT_GROUPS = {
  VH_F_placenta: 'the HRA places a term placenta in the uterus; the Visible Human Female was not pregnant and the site\'s reproductive entry describes the non-pregnant organ',
}
// What the female source does not model at all — stated on the page, never
// borrowed from the male model.
// Round 13: `native` is what the HRA itself models; the build appends what
// was fitted from the male model (see FITTING below) so the page states
// exactly which is which. Coverage stays 'partial' where the HRA's own set
// is partial, even though the fitted supplement completes the picture.
const FEMALE_COVERAGE = {
  skeleton: { coverage: 'partial', native: 'the HRA models the vertebral column, sacrum, coccyx, pelvis, femur, patella, tibia, fibula and the knee ligaments' },
  nervous: { coverage: 'partial', native: 'the HRA models the brain (Allen Human Brain Atlas regions), the spinal cord by segment, the eyes and the optic nerves' },
  organs: { coverage: 'full', native: 'the HRA models the digestive, urinary, respiratory, lymphatic and reproductive organs and the mammary glands' },
  vessels: { coverage: 'partial', native: 'the HRA models the heart, its coronary vessels and the major vessels of the trunk (aorta, venae cavae, pulmonary, hepatic, splenic, mesenteric, renal, iliac, uterine, ophthalmic)' },
  muscles: { coverage: 'partial', native: 'the HRA models only the muscles of the eye, the rectus femoris and the quadriceps tendon' },
  skin: { coverage: 'full', native: 'the skin is the Visible Human Female (a 59-year-old woman) as the HRA reconstructed it, unreshaped, above the ankles and the distal forearms' },
}
// What the round-13 fit adds per layer (prose; the counts come from the build).
const FITTED_SUMMARY = {
  skeleton: 'skull and teeth, hyoid and laryngeal cartilages, ribs and sternum, clavicles and scapulae, the bones of the arms, hands and feet, the intervertebral discs and the joints and ligaments',
  nervous: 'the cranial nerves (except the optic), spinal nerves, plexuses and every peripheral nerve, the sympathetic trunk, dura and falx, cauda equina and the ear',
  organs: 'thyroid and parathyroid glands, suprarenal glands, pituitary, pharynx, tongue, salivary glands, soft palate, uvula, gingiva and nasal mucosa',
  vessels: 'the arteries and veins of the head, neck, limbs and body wall, the pulmonary branches, lymph nodes and lymphatic trunks',
  muscles: 'every skeletal muscle, tendon, fascia, bursa and tendon sheath',
  skin: 'the feet and ankles and the hands and wrists (the Visible Human Female\'s feet are deformed in the source and her hands are posed unlike the fitted hand bones), and the hair of the head, eyebrows, eyelashes and pubic hair',
}
const MALE_COVERAGE = {
  skeleton: { coverage: 'full', note: 'bones, cartilages, joints and ligaments' },
  nervous: { coverage: 'full', note: 'brain, spinal cord, cranial and peripheral nerves, sympathetic trunk, eye and ear' },
  organs: { coverage: 'full', note: 'digestive, respiratory, urinary, reproductive and endocrine organs' },
  vessels: { coverage: 'full', note: 'heart, arteries, veins, lymph nodes, spleen and thymus' },
  muscles: { coverage: 'full', note: 'skeletal muscles, tendons, fascia, bursae and tendon sheaths' },
  skin: { coverage: 'full', note: 'the body surface as the regions of Terminologia Anatomica' },
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const t0 = Date.now()
const log = (message) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function download(url, name) {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, name)
  if (!existsSync(path)) {
    log(`downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    writeFileSync(path, Buffer.from(await response.arrayBuffer()))
  }
  const bytes = readFileSync(path)
  return { path, bytes, sha256: sha256(bytes), url }
}

/** "Clavicle.l" -> "Clavicle (left)"; "VH_F_left_ovary" -> "Left ovary". */
function nameFromNode(node, sex) {
  if (sex === 'male') {
    const part = node.match(/\.e(\d*)([lr])$/)
    if (part) {
      const side = part[2] === 'l' ? 'left' : 'right'
      return `${node.slice(0, part.index)} \u2014 part e${part[1] || '1'} (${side})`
    }
    return node.replace(/\.l$/, ' (left)').replace(/\.r$/, ' (right)').replace(/\.j$/, '')
  }
  let name = node.replace(/^(VH_F_|Allen_|Yao_)/, '')
  const side = name.match(/_(L|R)(?:_([a-z]))?$/)
  if (side) name = name.slice(0, side.index)
  name = name.replace(/_+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  name = name.charAt(0).toUpperCase() + name.slice(1)
  if (side) name += side[1] === 'L' ? ' (left' : ' (right'
  if (side && side[2]) name += `, ${side[2]}`
  if (side) name += ')'
  return name
}

function triangleCount(node) {
  const mesh = node.getMesh()
  if (!mesh) return 0
  let tris = 0
  for (const prim of mesh.listPrimitives()) {
    const indices = prim.getIndices()
    const count = indices ? indices.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0
    tris += Math.floor(count / 3)
  }
  return tris
}

function stripMaterials(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(null)
      for (const semantic of prim.listSemantics()) {
        if (/^(TEXCOORD_|COLOR_|TANGENT|NORMAL|JOINTS_|WEIGHTS_)/.test(semantic)) prim.setAttribute(semantic, null)
      }
    }
  }
}

// --------------------------------------------------------------------------
// Alias resolution: organ entries -> node names
// --------------------------------------------------------------------------
function compileAliases(organs) {
  return organs
    .filter((organ) => organ.mesh)
    .map((organ) => ({
      id: organ.id,
      name: organ.name,
      match: (organ.mesh.match ?? []).map((p) => new RegExp(p, 'i')),
      except: (organ.mesh.except ?? []).map((p) => new RegExp(p, 'i')),
      layer: organ.mesh.layer ?? null,
      systems: organ.systems,
    }))
}

const SIDE = / \((left|right)(, [a-z])?\)$/
const PART = / — part e\d+$/
function resolveOrgan(aliases, structure) {
  const strip = (f) => f.replace(SIDE, '').replace(PART, '')
  const names = [structure.name, structure.derived].filter((f) => typeof f === 'string' && f).map(strip)
  const fields = structure.hraLabel ? [...names, structure.hraLabel] : names
  const hits = (patterns, set) => patterns.some((re) => set.some((f) => re.test(f)))
  // Entries of the structure's OWN system (as the source records it) get
  // the first look: the HRA liver's Couinaud segments were landing on the
  // lungs through a "(left|right) ... segment" pattern, the kidney cortex
  // and a lymph node's paracortex on the cerebrum through "cortex". Only
  // then may any entry claim it -- teeth sit in the skeletal file but
  // belong to the mouth, the laryngeal cartilages to the larynx, the
  // ossicles to the ear, the pineal body (a brain region) to the pineal.
  const own = (alias) => !!structure.system && alias.systems.includes(structure.system)
  for (const alias of aliases) {
    if (own(alias) && hits(alias.match, fields) && !hits(alias.except, names)) return alias.id
  }
  for (const alias of aliases) {
    if (hits(alias.match, fields) && !hits(alias.except, names)) return alias.id
  }
  for (const alias of aliases) {
    if (alias.layer === structure.layer && !hits(alias.except, names)) return alias.id
  }
  return null
}

// --------------------------------------------------------------------------
// Layer assembly
// --------------------------------------------------------------------------
async function buildLayer(io, sex, layer, picks, options) {
  // picks: [{ doc, nodes: [Node], meta: Map<Node, structure> }]
  const out = new Document()
  out.createBuffer()
  const scene = out.createScene(`${sex}-${layer.id}`)
  const structures = []
  for (const pick of picks) {
    if (pick.nodes.length === 0) continue
    const copied = copyToDocument(out, pick.doc, pick.nodes)
    for (const node of pick.nodes) {
      const target = copied.get(node)
      scene.addChild(target)
      structures.push(pick.meta.get(node))
    }
  }
  const before = out.getRoot().listNodes().reduce((sum, node) => sum + triangleCount(node), 0)
  await out.transform(
    unpartition(),
    dedup(),
    prune(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: layer.ratio[sex], error: layer.error }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14 }),
  )
  // Per-structure triangle counts after simplification, for the manifest.
  const after = new Map(out.getRoot().listNodes().map((node) => [node.getName(), triangleCount(node)]))
  for (const structure of structures) structure.triangles = after.get(structure.node) ?? 0
  const bytes = Buffer.from(await io.writeBinary(out))
  const file = `${sex}-${layer.id}.glb`
  writeFileSync(join(OUT, file), bytes)
  const tris = [...after.values()].reduce((a, b) => a + b, 0)
  log(`${file}: ${structures.length} structures, ${before.toLocaleString()} -> ${tris.toLocaleString()} triangles, ${(bytes.length / 1e6).toFixed(2)} MB`)
  return {
    id: layer.id,
    label: layer.label,
    file: `anatomy/models/${file}`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    structures: structures.length,
    triangles: tris,
    sourceTriangles: before,
    ...options.coverage[layer.id],
  }
}

async function buildMale(io, aliases) {
  log('male: reading Anatria/Z-Anatomy files')
  const files = {}
  const sources = []
  for (const name of MALE_FILES) {
    const dl = await download(ANATRIA_RAW + name, name)
    sources.push({ file: name, url: dl.url, bytes: dl.bytes.length, sha256: dl.sha256 })
    files[name] = dl
  }
  const notice = await download(ANATRIA_RAW + 'NOTICE', 'NOTICE')
  const licence = await download(ANATRIA_RAW + 'LICENSE', 'LICENSE')
  const manifestDl = await download(ANATRIA_RAW + 'manifest.json', 'manifest.json')
  sources.push({ file: 'NOTICE', url: notice.url, bytes: notice.bytes.length, sha256: notice.sha256 })
  sources.push({ file: 'LICENSE', url: licence.url, bytes: licence.bytes.length, sha256: licence.sha256 })
  sources.push({ file: 'manifest.json', url: manifestDl.url, bytes: manifestDl.bytes.length, sha256: manifestDl.sha256 })
  writeFileSync(join(OUT, 'NOTICE-male.txt'), notice.bytes)
  const anatria = JSON.parse(manifestDl.bytes.toString('utf-8'))
  if (anatria.license !== 'CC-BY-SA-4.0') throw new Error(`male atlas licence changed: ${anatria.license}`)
  const byNode = new Map(anatria.organs.map((organ) => [`${organ.mesh_file}\t${organ.node}`, organ]))
  const homeFile = new Map()
  for (const organ of anatria.organs) if (!homeFile.has(organ.node)) homeFile.set(organ.node, organ.mesh_file)

  const docs = {}
  for (const name of MALE_FILES) {
    const doc = await io.read(files[name].path)
    stripMaterials(doc)
    await doc.transform(flatten(), prune())
    docs[name] = doc
  }

  const claimed = new Set()
  const omitted = []
  const layers = []
  const structures = []
  for (const layer of LAYERS) {
    const picks = []
    for (const name of MALE_LAYER_FILES[layer.id]) {
      const doc = docs[name]
      const system = MALE_SYSTEM[name.replace('_male.glb', '')]
      const nodes = []
      const meta = new Map()
      for (const node of doc.getRoot().listNodes()) {
        if (!node.getMesh()) continue
        const nodeName = node.getName()
        if (claimed.has(nodeName)) continue
        const record = byNode.get(`${name}\t${nodeName}`)
        if (!record && homeFile.has(nodeName) && homeFile.get(nodeName) !== name) {
          // Anatria's manifest files this node under another GLB; the copy
          // here is a stray (Z-Anatomy's nervous export carries 278 muscles).
          omitted.push({ node: nodeName, reason: 'stray duplicate' })
          continue
        }
        if (!/[A-Za-z]{2}/.test(nodeName)) {
          omitted.push({ node: nodeName, reason: 'unnamed' })
          claimed.add(nodeName)
          continue
        }
        const path = record?.path?.[0] ?? null
        if (path && MALE_OMIT_PATHS[path]) {
          omitted.push({ node: nodeName, reason: path })
          claimed.add(nodeName)
          continue
        }
        if (/\.o\d?[lr]$/.test(nodeName)) {
          // Origin/insertion patches not listed under the collection above.
          omitted.push({ node: nodeName, reason: 'Muscular insertions' })
          claimed.add(nodeName)
          continue
        }
        claimed.add(nodeName)
        const structure = {
          node: nodeName,
          layer: layer.id,
          name: record?.name_en ?? nameFromNode(nodeName, 'male'),
          latin: record?.ta2_latin?.replace(/^\(|\)$/g, '') ?? null,
          system: record ? MALE_SYSTEM[record.system] ?? system : system,
          group: path,
          organ: null,
        }
        structure.organ = resolveOrgan(aliases, structure)
        nodes.push(node)
        meta.set(node, structure)
        structures.push(structure)
      }
      picks.push({ doc, nodes, meta })
    }
    layers.push(await buildLayer(io, 'male', layer, picks, { coverage: MALE_COVERAGE }))
  }
  const omittedSummary = {}
  for (const item of omitted) omittedSummary[item.reason] = (omittedSummary[item.reason] ?? 0) + 1
  return {
    sex: 'male',
    source: {
      id: 'z-anatomy-anatria',
      title: 'Z-Anatomy male atlas (Terminologia Anatomica 2 nomenclature), GLB export by Anatria3D',
      author: anatria.credit,
      attribution: anatria.attribution,
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      sourcePage: ANATRIA_PAGE,
      upstream: [
        { title: 'Z-Anatomy, the libre 3D atlas of anatomy', url: 'https://www.z-anatomy.com/', licence: 'CC BY-SA 4.0' },
        { title: 'BodyParts3D, Database Center for Life Science (DBCLS), Japan', url: 'https://lifesciencedb.jp/bp3d/', licence: 'CC BY-SA 2.1 JP' },
      ],
      pinned: { repository: 'https://github.com/Nurkan1/Anatria-3D', commit: ANATRIA_COMMIT },
      notice: 'anatomy/models/NOTICE-male.txt',
      files: sources,
    },
    layers,
    omitted: Object.entries(omittedSummary).map(([reason, count]) => ({
      what: reason, count, why: MALE_OMIT_PATHS[reason] ?? reason,
    })),
    structures,
  }
}

async function buildFemale(io, aliases) {
  log('female: downloading / reading HRA united-female')
  const meta = await download(HRA_META, `united-female-${HRA_VERSION}-metadata.json`)
  const metadata = JSON.parse(meta.bytes.toString('utf-8'))
  if (!/creativecommons\.org\/licenses\/by\/4\.0/.test(metadata.license ?? '')) {
    throw new Error(`female source licence changed: ${metadata.license}`)
  }
  // The graph metadata wraps the digital object it was derived from; the
  // citation, DOI and title of the organ set itself live there.
  const derived = metadata.was_derived_from ?? {}
  const glb = await download(HRA_GLB, `3d-vh-f-united-${HRA_VERSION}.glb`)
  const doc = await io.read(glb.path)
  const root = doc.getRoot()
  // Ancestry (system, group) per mesh node, read BEFORE flattening.
  const ancestry = new Map()
  const walk = (node, system, group, depth) => {
    const name = node.getName()
    const nextSystem = depth === 1 ? name : system
    const nextGroup = depth === 2 ? name : group
    if (node.getMesh()) ancestry.set(node, { system: nextSystem, group: nextGroup ?? name })
    for (const child of node.listChildren()) walk(child, nextSystem, nextGroup, depth + 1)
  }
  for (const scene of root.listScenes()) for (const node of scene.listChildren()) walk(node, null, null, 0)
  // Display name: the HRA label when the node has one and it is unique in
  // the set ("Interlobar adipose tissue of left mammary gland"); otherwise
  // the node's own name read as words ("Ilium compact bone (left)"), because
  // the HRA labels tissues, not bones, in a few places (six nodes are all
  // labelled "compact bone tissue").
  const labelCount = new Map()
  for (const node of ancestry.keys()) {
    const label = node.getExtras()?.label
    if (typeof label === 'string' && label !== '-') labelCount.set(label, (labelCount.get(label) ?? 0) + 1)
  }
  stripMaterials(doc)
  await doc.transform(flatten(), prune())
  log(`female: ${ancestry.size} mesh nodes`)
  // Round 13: the region maps are needed now, to cut the skin where the
  // male feet and hands go in; the uncut skin gives the inside test.
  const regionLandmarks = femaleLandmarks(root)
  const maleLm = await maleLandmarks(io)
  const maps = buildRegionMaps(maleLm, regionLandmarks)
  const skinNode = root.listNodes().find((n) => n.getMesh() && /^VH_F_skin$/i.test(n.getName()))
  if (!skinNode) throw new Error('female skin node missing')
  const skin = skinPositionsBaked(skinNode)
  skinNode.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  const rawPos = Float32Array.from(skin.pos)
  const insideTest = buildInsideTest(rawPos, skin.idx)
  const nearestSkin = buildNearest(rawPos)
  log(`female: inside test over ${insideTest.columns.toLocaleString()} columns (${insideTest.oddColumns} with odd parity), ${insideTest.triangles.toLocaleString()} skin triangles`)
  const planes = skinCutPlanes(maps, maleLm)
  const cut = cutFemaleSkin(skin, planes)
  log(`female: skin cut at ankles y ${planes.leg.l.toFixed(3)}/${planes.leg.r.toFixed(3)} and forearms y ${planes.arm.l.toFixed(3)}/${planes.arm.r.toFixed(3)}: ${cut.dropped.toLocaleString()} faces removed, ${cut.lifted} rim vertices lifted onto the planes`)
  const skinAux = { planes, rings: cut.rings, zones: makeZones(planes), inside: insideTest.inside, nearest: nearestSkin, cut: { dropped: cut.dropped, kept: cut.kept, lifted: cut.lifted, insideTest: { columns: insideTest.columns, oddColumns: insideTest.oddColumns } } }

  const layers = []
  const structures = []
  const omitted = []
  const claimed = new Set()
  for (const layer of LAYERS) {
    const wanted = FEMALE_LAYER_GROUPS[layer.id].map((entry) => entry.split(':'))
    const nodes = []
    const nodeMeta = new Map()
    for (const node of root.listNodes()) {
      const anc = ancestry.get(node)
      if (!anc || claimed.has(node)) continue
      const hit = wanted.some(([system, group]) => anc.system === system && (!group || anc.group === group))
      if (!hit) continue
      claimed.add(node)
      if (FEMALE_OMIT_GROUPS[anc.group]) {
        omitted.push({ node: node.getName(), reason: anc.group })
        continue
      }
      const extras = node.getExtras() ?? {}
      const label = typeof extras.label === 'string' && extras.label !== '-' ? extras.label : null
      const derived = nameFromNode(node.getName(), 'female')
      const unique = label && labelCount.get(label) === 1
      const structure = {
        node: node.getName(),
        layer: layer.id,
        name: unique ? label.charAt(0).toUpperCase() + label.slice(1) : derived,
        derived,
        hraLabel: label,
        ontology: typeof extras.ontologyid === 'string' ? extras.ontologyid : null,
        system: FEMALE_SYSTEM[anc.system] ?? null,
        group: anc.group === anc.system ? null : nameFromNode(anc.group, 'female'),
        organ: null,
      }
      structure.organ = resolveOrgan(aliases, structure)
      nodes.push(node)
      nodeMeta.set(node, structure)
      structures.push(structure)
      node.setExtras({})
    }
    layers.push(await buildLayer(io, 'female', layer, [{ doc, nodes, meta: nodeMeta }], { coverage: FEMALE_COVERAGE }))
  }
  const unclaimed = [...ancestry.keys()].filter((node) => !claimed.has(node)).map((node) => node.getName())
  if (unclaimed.length) log(`female: ${unclaimed.length} nodes in no layer: ${unclaimed.slice(0, 10).join(', ')}`)
  // Landmark boxes for the fitted supplement (below), measured on this
  // model's own nodes before they are gone.
  const landmarks = {
    liver: unionBox(root.listNodes(), (n) => /liver/i.test(n)),
    spleen: unionBox(root.listNodes(), (n) => /spleen/i.test(n)),
    pancreas: unionBox(root.listNodes(), (n) => /pancreas|ucinate/i.test(n) && !/duct/i.test(n)),
    trachea: unionBox(root.listNodes(), (n) => /^VH_F_trachea$/i.test(n)),
  }
  const omittedSummary = {}
  for (const item of omitted) omittedSummary[item.reason] = (omittedSummary[item.reason] ?? 0) + 1
  return {
    sex: 'female',
    source: {
      id: 'hra-united-female',
      title: derived.title ? `${derived.title} (${HRA_VERSION})` : `3D Reference Organ Set for Female, ${HRA_VERSION} (united body)`,
      author: 'Kristen Browne and Heidi Schlehlein, HuBMAP Human Reference Atlas (NIH); after the Visible Human Female (U.S. National Library of Medicine)',
      attribution: derived.citation ?? null,
      citationOverall: derived.citationOverall ?? null,
      doi: derived.doi ?? null,
      licence: 'CC BY 4.0',
      licenceUrl: metadata.license,
      sourcePage: HRA_PAGE,
      version: metadata.version ?? HRA_VERSION,
      creationDate: derived.creation_date ?? metadata.creation_date ?? null,
      publisher: derived.publisher ?? metadata.publisher ?? null,
      files: [
        { file: `3d-vh-f-united-${HRA_VERSION}.glb`, url: glb.url, bytes: glb.bytes.length, sha256: glb.sha256 },
        { file: `united-female-${HRA_VERSION}-metadata.json`, url: meta.url, bytes: meta.bytes.length, sha256: meta.sha256 },
      ],
    },
    layers,
    omitted: Object.entries(omittedSummary).map(([reason, count]) => ({
      what: reason, count, why: FEMALE_OMIT_GROUPS[reason] ?? reason,
    })),
    structures,
    landmarks,
    regionLandmarks,
    maleLm,
    maps,
    skinAux,
  }
}

// --------------------------------------------------------------------------
// Female supplement: stomach and oesophagus, fitted from the male model
// --------------------------------------------------------------------------
// The Human Reference Atlas has no stomach and no oesophagus for either
// sex (its 81-object reference-organ index, checked 2026-09-19), so a
// female digestive tract would otherwise stop at the duodenum. Andy asked
// for the two to be present. They are the male Z-Anatomy organs FITTED
// into the female body: a per-axis affine derived from the organs both
// models share (liver, spleen, pancreas -- the stomach's neighbours), and
// for the oesophagus a blend from that map at its stomach end toward the
// trachea-aligned map at its top, so it runs behind the female trachea
// and reaches the fitted stomach. They ship in their own file under their
// own licence (CC BY-SA 4.0, share-alike) and are labelled as fitted
// wherever they appear: on the structure card, in the manifest, in the
// credit line. Their position is indicative, not measured.
const FITTED_NODES = ['Stomach', 'Mucosa of stomach', 'Oesophagus']
const FITTED_ORGAN = { Stomach: 'stomach', 'Mucosa of stomach': 'stomach', Oesophagus: 'oesophagus' }

function unionBox(nodes, pred) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let n = 0
  for (const node of nodes) {
    if (!node.getMesh() || !pred(node.getName())) continue
    const b = getBounds(node)
    n += 1
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], b.min[i])
      max[i] = Math.max(max[i], b.max[i])
    }
  }
  if (!n) throw new Error('landmark not found')
  return { n, min, max }
}
const unionOf = (...boxes) => ({
  min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))),
  max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]))),
})
const centre = (b) => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2)

async function buildFemaleFitted(io, femaleLandmarks, maleStructures) {
  log('female: fitting the male stomach and oesophagus')
  const digestive = await io.read(join(CACHE, 'digestive_male.glb'))
  const respiratory = await io.read(join(CACHE, 'respiratory_male.glb'))
  const lymphatic = await io.read(join(CACHE, 'lymphatic_male.glb'))
  await digestive.transform(flatten())
  const dNodes = digestive.getRoot().listNodes()
  const male = {
    liver: unionBox(dNodes, (n) => /liver/i.test(n)),
    pancreas: unionBox(dNodes, (n) => /^pancreas$/i.test(n)),
    spleen: unionBox(lymphatic.getRoot().listNodes(), (n) => /^spleen$/i.test(n)),
    trachea: unionBox(respiratory.getRoot().listNodes(), (n) => /^trachea$/i.test(n)),
    oesophagus: unionBox(dNodes, (n) => /^oesophagus$/i.test(n)),
  }
  const mBox = unionOf(male.liver, male.spleen, male.pancreas)
  const fBox = unionOf(femaleLandmarks.liver, femaleLandmarks.spleen, femaleLandmarks.pancreas)
  const scale = [0, 1, 2].map((i) => (fBox.max[i] - fBox.min[i]) / (mBox.max[i] - mBox.min[i]))
  // Both models: +x is the body's left (the spleen), -z posterior (the
  // kidneys and spleen), +y up. Asserted, not assumed.
  const side = (lm) => Math.sign(centre(lm.spleen)[0] - centre(lm.liver)[0])
  if (side(male) !== side(femaleLandmarks)) throw new Error('models disagree on left/right')
  const S = (p) => [0, 1, 2].map((i) => fBox.min[i] + (p[i] - mBox.min[i]) * scale[i])
  const mT = centre(male.trachea)
  const fT = centre(femaleLandmarks.trachea)
  const T = (p) => [
    fT[0] + (p[0] - mT[0]) * scale[0],
    femaleLandmarks.trachea.max[1] + (p[1] - male.trachea.max[1]) * scale[1],
    fT[2] + (p[2] - mT[2]) * scale[2],
  ]
  const yBot = male.oesophagus.min[1]
  const yTop = male.oesophagus.max[1]
  const maps = {
    Stomach: S,
    'Mucosa of stomach': S,
    Oesophagus: (p) => {
      const t = Math.max(0, Math.min(1, (p[1] - yBot) / (yTop - yBot)))
      const a = S(p)
      const b = T(p)
      return [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t)
    },
  }

  const picks = dNodes.filter((node) => node.getMesh() && FITTED_NODES.includes(node.getName()))
  if (picks.length !== FITTED_NODES.length) throw new Error(`fitted nodes: found ${picks.map((n) => n.getName())}`)
  const out = new Document()
  out.createBuffer()
  const scene = out.createScene('female-organs-fitted')
  const copied = copyToDocument(out, digestive, picks)
  const structures = []
  let before = 0
  for (const src of picks) {
    const node = copied.get(src)
    scene.addChild(node)
    // Bake the node's transform into the vertices, then apply the fit.
    const world = src.getWorldMatrix()
    const map = maps[src.getName()]
    for (const prim of node.getMesh().listPrimitives()) {
      const acc = prim.getAttribute('POSITION')
      const arr = Float32Array.from(acc.getArray())
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i]
        const y = arr[i + 1]
        const z = arr[i + 2]
        const wx = world[0] * x + world[4] * y + world[8] * z + world[12]
        const wy = world[1] * x + world[5] * y + world[9] * z + world[13]
        const wz = world[2] * x + world[6] * y + world[10] * z + world[14]
        const q = map([wx, wy, wz])
        arr[i] = q[0]
        arr[i + 1] = q[1]
        arr[i + 2] = q[2]
      }
      acc.setArray(arr)
    }
    node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    before += triangleCount(node)
    const maleEntry = maleStructures.find((s) => s.node === src.getName()) ?? {}
    structures.push({
      node: src.getName(),
      layer: 'organs',
      name: maleEntry.name ?? src.getName(),
      latin: maleEntry.latin ?? null,
      system: 'digestive',
      group: 'Digestive system',
      organ: FITTED_ORGAN[src.getName()],
      fitted: 'male',
    })
  }
  const layer = LAYERS.find((l) => l.id === 'organs')
  await out.transform(
    unpartition(),
    dedup(),
    prune(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: layer.ratio.male, error: layer.error }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14 }),
  )
  const after = new Map(out.getRoot().listNodes().map((node) => [node.getName(), triangleCount(node)]))
  for (const structure of structures) structure.triangles = after.get(structure.node) ?? 0
  const bytes = Buffer.from(await io.writeBinary(out))
  const file = 'female-organs-fitted.glb'
  writeFileSync(join(OUT, file), bytes)
  const tris = [...after.values()].reduce((a, b) => a + b, 0)
  log(`${file}: ${structures.length} structures, ${before.toLocaleString()} -> ${tris.toLocaleString()} triangles, ${(bytes.length / 1e6).toFixed(2)} MB`)
  const round = (v) => Number(v.toFixed(4))
  const fit = {
    method: 'per-axis affine from the union box of liver, spleen and pancreas in each model; the oesophagus blends from that map at its stomach end to a trachea-aligned map at its top',
    scale: scale.map(round),
    maleLandmarkBox: { min: mBox.min.map(round), max: mBox.max.map(round) },
    femaleLandmarkBox: { min: fBox.min.map(round), max: fBox.max.map(round) },
  }
  return {
    supplement: {
      id: 'organs-fitted',
      layer: 'organs',
      file: `anatomy/models/${file}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      structures: structures.length,
      triangles: tris,
      sourceTriangles: before,
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      note: 'stomach and oesophagus fitted from the male Z-Anatomy model; position indicative',
    },
    source: {
      id: 'z-anatomy-fitted',
      title: 'Stomach and oesophagus, fitted from the male model',
      author: 'Z-Anatomy (after BodyParts3D, DBCLS), via the Anatria3D GLB export; fitted into the female body for this site',
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      sourcePage: ANATRIA_PAGE,
      upstream: [
        { title: 'Z-Anatomy, the libre 3D atlas of anatomy', url: 'https://www.z-anatomy.com/', licence: 'CC BY-SA 4.0' },
        { title: 'BodyParts3D, Database Center for Life Science (DBCLS), Japan', url: 'https://lifesciencedb.jp/bp3d/', licence: 'CC BY-SA 2.1 JP' },
      ],
      pinned: { repository: 'https://github.com/Nurkan1/Anatria-3D', commit: ANATRIA_COMMIT },
      notice: 'anatomy/models/NOTICE-male.txt',
      why: 'the Human Reference Atlas has no stomach or oesophagus for either sex (reference-organ index, 81 objects, checked 2026-09-19)',
      fit,
      files: [{ file: 'digestive_male.glb', url: `${ANATRIA_RAW}digestive_male.glb`, bytes: readFileSync(join(CACHE, 'digestive_male.glb')).length, sha256: sha256(readFileSync(join(CACHE, 'digestive_male.glb'))) }],
    },
    structures,
  }
}

// --------------------------------------------------------------------------
// FITTING (round 13): the male structures the HRA lacks, fitted region-wise
// into the female frame
// --------------------------------------------------------------------------
// No free female whole-body skeleton, muscle, nerve or vessel set exists
// (§65.2), so the §65.9 exception (the fitted stomach) is extended: every
// male structure of a layer that the HRA does not model is carried into the
// female body by a REGION FIELD:
//
//   * the male skin's Terminologia Anatomica regions partition the male body
//     into eight classes (head, trunk incl. neck, left/right upper limb,
//     left/right thigh, left/right leg, left/right foot); a vertex belongs to
//     the classes of its nearest skin patches, with Gaussian weights
//     (sigma 3 cm) so the maps blend across a boundary instead of tearing;
//   * each class has its own map from the male to the female frame, derived
//     from landmarks BOTH models share where they exist and from the female
//     skin silhouette otherwise:
//       trunk  the spine: every vertebra C1..L5, the sacrum and coccyx are
//              matched by name, so height is a piecewise-linear map through
//              their centres; width and depth scale about the spine at each
//              level (lungs at T4, liver+spleen+kidneys+pancreas at T10..L5,
//              the pelvis at S1, 1.0 in the neck);
//       head   a per-axis affine from the union box of the brain and eyes;
//       limbs  a similarity (rotation + uniform scale) taking the male
//              segment axis onto the female one: femur head->knee and tibia
//              plateau->ankle from the bones both models have; the upper
//              limb shoulder->fingertip and the feet from the female skin
//              silhouette (measured on skin v1.5, asserted against the
//              skin's bounding box so a source change is caught).
//   * a male structure the HRA already provides (matched by normalised
//     name, e.g. "Vertebra L3" = "Lumbar vertebra 3", "Brachiocephalic
//     trunk" = "Brachiocephalic artery", the whole heart and coronary set,
//     the brain, cord and eye) is NOT duplicated; where the HRA's set is
//     fragmentary (pulmonary and trunk vessels) the native pieces stay and
//     only the branches it lacks are fitted, and the coverage note says so.
//
// Every fitted node ships in `female-<layer>-fitted.glb` (CC BY-SA 4.0,
// share-alike, NOTICE-male.txt), is marked `fitted: 'male'` in the structure
// index (the card says so), and the manifest records the maps with their
// numbers. Positions are indicative, not measured.

const FIT_SIGMA = 0.03
const FIT_SEARCH = 0.06

// Male skin patch (TA2 region, side stripped) -> region class.
const PATCH_CLASS = [
  [/^(Frontal|Parietal|Occipital|Temporal|Orbital|Nasal|Oral|Mental|Buccal|Zygomatic|Infra-orbital|Parotideomasseteric|Auricular|Mastoid) region$|^(Hairs of head|Philtrum|Eyebrow|Hairs of eyebrow|Eyelashes|Helix|Antihelix|Antitragus|Tragus|Apex of auricle|Auricular tubercle|Cavity of concha|Concha of auricle|Crura of antihelix|Cymba conchae|Eminentia|Fossa antihelica|Intertragic incisure|Lobule of auricle|Posterior auricular groove|Scapha|Triangular fossa|Anterior notch of auricle|Angle of mouth|Labial commissure|Mentolabial sulcus|Nasolabial sulcus|Tubercle of upper lip)/, 'head'],
  [/^(Deltoid region|Anterior region of arm|Posterior region of arm|Lateral bicipital groove|Medial bicipital groove|Cubital fossa|Anterior region of elbow|Posterior region of elbow)$/, 'upperarm'],
  [/^(Anterior region of forearm|Posterior region of forearm|Lateral border of forearm|Medial border of forearm|Anterior region of wrist|Posterior region of wrist|Radial foveola)$/, 'forearm'],
  [/^(Dorsum of hand|Palm|Dorsal surfaces of digits of hand|Palmar surfaces of digits of hand|Nail plate|Perionyx)$/, 'hand'],
  [/^(Anterior region of thigh|Posterior region of thigh|Femoral triangle|Hip region|Anterior region of knee|Posterior region of knee|Popliteal fossa)$/, 'thigh'],
  [/^(Anterior region of leg|Posterior region of leg|Lateral malleolus|Medial malleolus|Lateral retromalleolar region|Medial retromalleolar region|Anterior region of ankle)$/, 'leg'],
  [/^(Dorsum of foot|Sole|Heel region|Dorsal surfaces of digits of foot|Plantar surfaces of digits of foot|Hallucial eminence|Lateral border of foot|Medial border of foot|Distal transverse arch of foot|Proximal transverse arch of foot|Lateral part of longitudinal arch of foot|Medial part of longitudinal arch of foot|Metatarsal region|Nail plate \(foot\)|Perionyx \(foot\))$/, 'foot'],
]
function patchClass(nodeName) {
  const side = nodeName.endsWith('.l') ? 'l' : nodeName.endsWith('.r') ? 'r' : null
  const base = nodeName.replace(/\.[lr]$/, '')
  for (const [re, cls] of PATCH_CLASS) {
    if (re.test(base)) return cls === 'head' ? 'head' : `${cls}.${side ?? (base.endsWith('foot)') ? 'l' : 'l')}`
  }
  return 'trunk'
}

// Male structures the HRA already provides (matched by normalised name)
// plus whole groups it covers; and what is never fitted.
/** "Femur (left)" / "Left femur" -> { side: 'left', core: 'femur' }. */
function nameKey(name) {
  let n = name.toLowerCase().replace(/\s+/g, ' ').trim()
  let side = null
  const suffix = n.match(/ \((left|right)(, [a-z])?\)$/)
  if (suffix) { side = suffix[1]; n = n.slice(0, suffix.index) }
  const prefix = n.match(/^(left|right) /)
  if (prefix) { side = prefix[1]; n = n.slice(prefix[0].length) }
  n = n.replace(/ (left|right) /, ' ').replace(/ muscle$/, '').replace(/ [abc]$/, '').replace(/ segment1$/, ' segment').trim()
  return { side, core: n }
}
function normaliseName(name) {
  const { side, core } = nameKey(name)
  return side ? `${side} ${core}` : core
}
const NAME_SYNONYMS = {
  'brachiocephalic trunk': 'brachiocephalic artery',
  'thoracic aorta': 'descending aorta',
  'abdominal aorta': 'descending aorta',
  'coeliac trunk': 'celiac trunk',
  'inferior vena cava (abdominal part)': 'inferior vena cava',
  'inferior vena cava (thoracic part)': 'inferior vena cava',
  'ophthalmic artery': 'opthalmic artery',
  'bifurcation of pulmonary trunk': 'pulmonary trunk',
  'atlas (c1)': 'cervical vertebra 1',
  'axis (c2)': 'cervical vertebra 2',
  'hip bone': 'ilium compact bone',
  'sacrum': 'fused sacrum',
  'superficial part of tibial collateral ligament': 'tibial collateral ligament',
  'deep part of tibial collateral ligament': 'tibial collateral ligament',
  'medial meniscus': 'meniscus',
  'lateral meniscus': 'meniscus',
  'optic nerve (ii)': 'optic nerve',
  'pineal gland': 'pineal body',
  'oesophagus': 'oesophagus',
}
function femaleEquivalent(maleName, femaleNames) {
  const { side, core } = nameKey(maleName)
  let c = core
  const v = c.match(/^vertebra ([ctl])(\d+)$/)
  if (v) c = `${{ c: 'cervical', t: 'thoracic', l: 'lumbar' }[v[1]]} vertebra ${v[2]}`
  c = NAME_SYNONYMS[c] ?? c
  const candidates = side ? [`${side} ${c}`, `${side} mammalian ${c}`] : [c, `mammalian ${c}`]
  for (const k of candidates) if (femaleNames.has(k)) return k
  // A structure the HRA models once, unsided (its "Meniscus", "Internal
  // iliac vein"), stands for both sides.
  if (side && femaleNames.has(c) && UNSIDED_NATIVE.test(c)) return c
  return null
}
const UNSIDED_NATIVE = /^(meniscus|tibial collateral ligament|internal iliac vein|internal pudendal vein|ophthalmic vein|opthalmic artery|pineal body|ilium compact bone)$/
// Per layer: male groups the HRA covers wholesale (with exceptions kept),
// and structures never fitted (sex-specific, or membranes shaped to the
// male viscera).
const FIT_RULES = {
  skeleton: { omitGroups: [], keepInGroup: null, never: null },
  nervous: {
    omitGroups: ['Central nervous system', null],
    keepInGroup: /dura|falx|cauda equina|root of spinal nerve/i,
    never: /^(Cornea|Iris|Lens|Retina|Sclera|Vitreous body|Anterior chamber of eyeball|Anterior segment of eyeball|Posterior segment of eyeball|Suspensory ligament of eyeball|Zonular fibres|Choroid plexus)/i,
    neverWhy: 'the HRA models the eye in its own detail (retina, sclera, lens, iris, humours)',
    omitGroupsWhy: 'the HRA models the brain (Allen atlas regions) and the spinal cord by segment; only the dura, falx, cauda equina and spinal roots are taken from this group',
  },
  vessels: {
    omitGroups: ['Heart', 'Cardiac vessels'],
    keepInGroup: null,
    never: null,
    omitGroupsWhy: 'the HRA models the heart (chambers, valves, papillary muscles, septum) and its coronary arteries and cardiac veins',
  },
  muscles: { omitGroups: [], keepInGroup: null, never: null },
  organs: {
    omitGroups: [],
    keepInGroup: null,
    only: /^(Thyroid gland|Superior parathyroid gland|Inferior parathyroid gland|Suprarenal gland|Adenohypophysis|Neurohypophysis|Pharynx|Nasopharynx|Oropharynx|Laryngopharynx|Tongue|Parotid gland|\(Accessory parotid gland\)|Parotid duct|Submandibular gland|Submandibular duct|Sublingual gland|Soft palate|Uvula of palate|Gingiva|Mucosa of nasal cavity)$/,
    onlyWhy: 'only the glands and mouth/throat organs the HRA lacks are fitted: the digestive, urinary and respiratory organs are the HRA\'s own (the stomach and oesophagus are the separate §65.9 fit), the male genital organs and urethra are sex-specific, and the omenta, mesocolon, taeniae and pleura are membranes shaped to the male viscera that would not follow the female organs',
  },
  skin: {
    omitGroups: [],
    keepInGroup: null,
    only: /^(Hairs of head|Hairs of eyebrow|Eyelashes|Pubic hairs)$/,
    onlyClasses: /^(foot|leg|hand|forearm)\./,
    onlyWhy: 'the female skin is the HRA\'s own above the ankles and the distal forearms; the hair (head, eyebrows, eyelashes, pubic) is fitted because the HRA skin has none, and the skin of the feet, ankles, hands and wrists is fitted because the Visible Human Female\'s feet are deformed in the source and her hands are posed unlike the fitted hand bones',
  },
}

// Female skin landmarks measured on united-female v1.5 (probe of the skin
// silhouette by 2 cm slabs, .scratch/anatomy-r13-probe2.mjs); asserted
// against the skin's bounding box below.
const FEMALE_SKIN_BOX = { min: [-0.4895, -0.7948, -0.2226], max: [0.4778, 0.8716, 0.1067] }
// The upper limb is three segments: the female arm hangs with the upper
// arm near vertical and the forearm abducted (slab centres x 0.218 at
// y 0.345, 0.267 at 0.265, 0.361 at 0.105, 0.39 at 0.045), so one straight
// shoulder-to-fingertip axis missed the skin by 4 cm at the upper arm.
const FEMALE_SKIN_LANDMARKS = {
  shoulder: { l: [0.175, 0.555, -0.095], r: [-0.185, 0.555, -0.095] },
  elbow: { l: [0.255, 0.265, -0.085], r: [-0.268, 0.265, -0.085] },
  wrist: { l: [0.395, 0.05, -0.05], r: [-0.415, 0.05, -0.05] },
  fingertip: { l: [0.42, -0.078, -0.01], r: [-0.43, -0.078, -0.01] },
  foot: {
    l: { min: [0.088, -0.7948, -0.167], max: [0.181, -0.70, 0.107] },
    r: { min: [-0.205, -0.7948, -0.155], max: [-0.109, -0.70, 0.107] },
  },
}

function worldPositions(node) {
  const m = node.getWorldMatrix()
  const out = []
  for (const prim of node.getMesh().listPrimitives()) {
    const a = prim.getAttribute('POSITION').getArray()
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2]
      out.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]])
    }
  }
  return out
}
const boxCentre = (b) => [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2)
const boxSize = (b) => [0, 1, 2].map((i) => b.max[i] - b.min[i])
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const unit = (a) => scl(a, 1 / len(a))
const round4 = (v) => Number(v.toFixed(4))

/** Centroid of the vertices in the top or bottom `frac` of a node's height. */
function endCentroid(node, end, frac = 0.06) {
  const pts = worldPositions(node)
  let y0 = Infinity, y1 = -Infinity
  for (const p of pts) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1] }
  const cut = end === 'top' ? y1 - (y1 - y0) * frac : y0 + (y1 - y0) * frac
  const c = [0, 0, 0]
  let n = 0
  for (const p of pts) {
    if (end === 'top' ? p[1] >= cut : p[1] <= cut) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; n += 1 }
  }
  return scl(c, 1 / n)
}

/** Similarity taking segment (a0 -> a1) onto (b0 -> b1): rotation + uniform scale. */
function similarity(a0, a1, b0, b1) {
  const u = sub(a1, a0), v = sub(b1, b0)
  const s = len(v) / len(u)
  const un = unit(u), vn = unit(v)
  const axis = cross(un, vn)
  const sinA = len(axis), cosA = dot(un, vn)
  const k = sinA > 1e-9 ? unit(axis) : [0, 0, 1]
  const rot = (p) => {
    // Rodrigues
    if (sinA < 1e-9) return p
    const kp = cross(k, p)
    const kd = dot(k, p)
    return [0, 1, 2].map((i) => p[i] * cosA + kp[i] * sinA + k[i] * kd * (1 - cosA))
  }
  const map = (p) => add(b0, scl(rot(sub(p, a0)), s))
  return { map, meta: { from: [a0.map(round4), a1.map(round4)], to: [b0.map(round4), b1.map(round4)], scale: round4(s), rotationDeg: round4((Math.atan2(sinA, cosA) * 180) / Math.PI) } }
}

/** Per-axis affine taking box A onto box B. */
function boxAffine(a, b) {
  const s = [0, 1, 2].map((i) => (b.max[i] - b.min[i]) / (a.max[i] - a.min[i]))
  const map = (p) => [0, 1, 2].map((i) => b.min[i] + (p[i] - a.min[i]) * s[i])
  return { map, meta: { from: { min: a.min.map(round4), max: a.max.map(round4) }, to: { min: b.min.map(round4), max: b.max.map(round4) }, scale: s.map(round4) } }
}

/** Spine-driven trunk warp: y through matched vertebra centres; x/z about the spine. */
function trunkWarp(male, female) {
  // levels sorted bottom -> top by male y
  const levels = male.spine.map((m, i) => ({ name: m.name, m: m.centre, f: female.spine[i].centre })).sort((a, b) => a.m[1] - b.m[1])
  const keyScale = male.scaleLevels // [{y, sx, sz}] in male y, sorted ascending
  const interp = (arr, y, get) => {
    if (y <= arr[0].y) return get(arr[0], arr[1], (y - arr[0].y) / (arr[1].y - arr[0].y))
    for (let i = 0; i < arr.length - 1; i += 1) {
      if (y <= arr[i + 1].y) return get(arr[i], arr[i + 1], (y - arr[i].y) / (arr[i + 1].y - arr[i].y))
    }
    const n = arr.length
    return get(arr[n - 2], arr[n - 1], (y - arr[n - 2].y) / (arr[n - 1].y - arr[n - 2].y))
  }
  const spineArr = levels.map((l) => ({ y: l.m[1], m: l.m, f: l.f }))
  const lerp = (a, b, t) => a + (b - a) * t
  const map = (p) => {
    const y = p[1]
    const sp = interp(spineArr, y, (a, b, t) => ({ m: [lerp(a.m[0], b.m[0], t), lerp(a.m[1], b.m[1], t), lerp(a.m[2], b.m[2], t)], f: [lerp(a.f[0], b.f[0], t), lerp(a.f[1], b.f[1], t), lerp(a.f[2], b.f[2], t)] }))
    const t2 = Math.max(0, Math.min(1, 1)) // scale levels clamp handled inside
    const sc = interp(keyScale, Math.max(keyScale[0].y, Math.min(keyScale[keyScale.length - 1].y, y)), (a, b, t) => ({ sx: lerp(a.sx, b.sx, Math.max(0, Math.min(1, t))), sz: lerp(a.sz, b.sz, Math.max(0, Math.min(1, t))) }))
    void t2
    return [sp.f[0] + (p[0] - sp.m[0]) * sc.sx, sp.f[1], sp.f[2] + (p[2] - sp.m[2]) * sc.sz]
  }
  return { map, meta: { vertebrae: levels.map((l) => ({ level: l.name, male: l.m.map(round4), female: l.f.map(round4) })), scaleLevels: keyScale.map((k) => ({ maleY: round4(k.y), at: k.at, sx: round4(k.sx), sz: round4(k.sz) })) } }
}

/** Region field over the male skin patches: nearest patches with Gaussian weights. */
function buildRegionField(skinNodes) {
  const pts = []
  for (const node of skinNodes) {
    const cls = patchClass(node.getName())
    const positions = worldPositions(node)
    // every 2nd vertex is plenty (55k -> 28k samples)
    for (let i = 0; i < positions.length; i += 2) pts.push({ p: positions[i], cls })
  }
  const cell = FIT_SEARCH / 2
  const grid = new Map()
  const key = (ix, iy, iz) => `${ix},${iy},${iz}`
  for (const pt of pts) {
    const k = key(Math.floor(pt.p[0] / cell), Math.floor(pt.p[1] / cell), Math.floor(pt.p[2] / cell))
    let list = grid.get(k)
    if (!list) { list = []; grid.set(k, list) }
    list.push(pt)
  }
  const coarse = pts.filter((_, i) => i % 8 === 0)
  const query = (p) => {
    const ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell), iz = Math.floor(p[2] / cell)
    let found = []
    for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) for (let dz = -2; dz <= 2; dz += 1) {
      const list = grid.get(key(ix + dx, iy + dy, iz + dz))
      if (list) for (const pt of list) found.push(pt)
    }
    if (found.length < 4) found = coarse
    let dmin = Infinity
    const ds = new Array(found.length)
    for (let i = 0; i < found.length; i += 1) {
      const q = found[i].p
      const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
      ds[i] = d2
      if (d2 < dmin) dmin = d2
    }
    const weights = new Map()
    const inv = 1 / (2 * FIT_SIGMA * FIT_SIGMA)
    for (let i = 0; i < found.length; i += 1) {
      const w = Math.exp(-(ds[i] - dmin) * inv)
      if (w < 1e-4) continue
      weights.set(found[i].cls, (weights.get(found[i].cls) ?? 0) + w)
    }
    let total = 0
    for (const w of weights.values()) total += w
    for (const [k, w] of weights) weights.set(k, w / total)
    return weights
  }
  return { query, samples: pts.length }
}

/** Landmarks of the male model, read from its shipped layer files. */
async function maleLandmarks(io) {
  const read = async (layer) => {
    const doc = await io.read(join(OUT, `male-${layer}.glb`))
    await doc.transform(dequantize())
    return doc
  }
  const skeleton = await read('skeleton')
  const nervous = await read('nervous')
  const organs = await read('organs')
  const skin = await read('skin')
  const nodes = (doc) => doc.getRoot().listNodes().filter((n) => n.getMesh())
  const sk = nodes(skeleton)
  const find = (list, re) => list.find((n) => re.test(n.getName()))
  const spine = []
  const push = (name, re) => { const n = find(sk, re); if (!n) throw new Error(`male landmark ${name} missing`); spine.push({ name, centre: boxCentre(getBounds(n)) }) }
  push('C1', /^Atlas \(C1\)$/); push('C2', /^Axis \(C2\)$/)
  for (let i = 3; i <= 7; i += 1) push(`C${i}`, new RegExp(`^Vertebra C${i}$`))
  for (let i = 1; i <= 12; i += 1) push(`T${i}`, new RegExp(`^Vertebra T${i}$`))
  for (let i = 1; i <= 5; i += 1) push(`L${i}`, new RegExp(`^Vertebra L${i}$`))
  push('sacrum', /^Sacrum$/); push('coccyx', /^Coccyx$/)
  const boxOf = (list, re) => unionBox(list, (n) => re.test(n))
  const femur = { l: find(sk, /^Femur\.l$/), r: find(sk, /^Femur\.r$/) }
  const tibia = { l: find(sk, /^Tibia\.l$/), r: find(sk, /^Tibia\.r$/) }
  const humerus = { l: find(sk, /^Humerus\.l$/), r: find(sk, /^Humerus\.r$/) }
  const radius = { l: find(sk, /^Radius\.l$/), r: find(sk, /^Radius\.r$/) }
  const ulna = { l: find(sk, /^Ulna\.l$/), r: find(sk, /^Ulna\.r$/) }
  const mid = (a, b) => [0, 1, 2].map((i) => (a[i] + b[i]) / 2)
  const fingertip = { l: boxCentre(getBounds(find(sk, /^Distal phalanx of third finger of hand\.l$/))), r: boxCentre(getBounds(find(sk, /^Distal phalanx of third finger of hand\.r$/))) }
  const skinNodes = nodes(skin)
  const footPatch = (side) => boxOf(skinNodes, new RegExp(`^(Dorsum of foot|Sole|Heel region|Dorsal surfaces of digits of foot|Plantar surfaces of digits of foot|Metatarsal region|Lateral border of foot|Medial border of foot)\\.${side}$`))
  const nv = nodes(nervous)
  const head = unionOf(
    boxOf(nv, /^(Cerebrum|Cerebellum|Frontal lobe|Parietal lobe|Occipital lobe|Temporal lobe|Insula|Pons|Midbrain|Medulla oblongata|Thalamus|Corpus callosum|Precentral gyrus|Postcentral gyrus|Superior frontal gyrus|Middle frontal gyrus|Inferior temporal gyrus|Cuneus|Precuneus|Lingual gyrus|Occipital pole|Culmen|Declive|Flocculus)/i),
    boxOf(nv, /^(Sclera|Cornea|Retina|Vitreous body)/i),
  )
  const og = nodes(organs)
  const lungs = boxOf(og, /lobe of (left|right) lung$/i)
  const abdomen = unionOf(boxOf(og, /^Liver$/i), boxOf(og, /^Kidney\./i), boxOf(og, /^Pancreas$/i), boxOf(nodes(await read('vessels')), /^Spleen$/i))
  const pelvis = boxOf(sk, /^Hip bone\./)
  return {
    spine, head, lungs, abdomen, pelvis,
    femur: { l: [endCentroid(femur.l, 'top'), endCentroid(femur.l, 'bottom')], r: [endCentroid(femur.r, 'top'), endCentroid(femur.r, 'bottom')] },
    tibia: { l: [endCentroid(tibia.l, 'top'), endCentroid(tibia.l, 'bottom')], r: [endCentroid(tibia.r, 'top'), endCentroid(tibia.r, 'bottom')] },
    shoulder: { l: endCentroid(humerus.l, 'top', 0.08), r: endCentroid(humerus.r, 'top', 0.08) },
    elbow: { l: endCentroid(humerus.l, 'bottom', 0.06), r: endCentroid(humerus.r, 'bottom', 0.06) },
    wrist: { l: mid(endCentroid(radius.l, 'bottom'), endCentroid(ulna.l, 'bottom')), r: mid(endCentroid(radius.r, 'bottom'), endCentroid(ulna.r, 'bottom')) },
    fingertip,
    foot: { l: footPatch('l'), r: footPatch('r') },
    skinNodes,
    skinBox: boxOf(skinNodes, /./),
  }
}

/** Landmarks of the female model, from the HRA doc (before its nodes are consumed). */
function femaleLandmarks(root) {
  const nodes = root.listNodes().filter((n) => n.getMesh())
  const find = (re) => nodes.find((n) => re.test(n.getName()))
  const spine = []
  const push = (name, re) => { const n = find(re); if (!n) throw new Error(`female landmark ${name} missing`); spine.push({ name, centre: boxCentre(getBounds(n)) }) }
  for (let i = 1; i <= 7; i += 1) push(`C${i}`, new RegExp(`^VH_F_cervical_vertebra_${i}$`))
  for (let i = 1; i <= 12; i += 1) push(`T${i}`, new RegExp(`^VH_F_thoracic_vertebra_${i}$`))
  for (let i = 1; i <= 5; i += 1) push(`L${i}`, new RegExp(`^VH_F_lumbar_vertebra_${i}$`))
  push('sacrum', /^VH_F_sacrum$/); push('coccyx', /^VH_F_coccyx$/)
  const boxOf = (re) => unionBox(nodes, (n) => re.test(n))
  const femur = { l: find(/^VH_F_femur_L$/), r: find(/^VH_F_femur_R$/) }
  const tibia = { l: find(/^VH_F_tibia_L$/), r: find(/^VH_F_tibia_R$/) }
  const head = unionOf(boxOf(/(white_matter_of_forebrain|frontal_pole|occipital_pole|temporal_pole|precentral_gyrus|postcentral_gyrus|superior_frontal_gyrus|cerebellar_vermis|lateral_hemisphere_of_cerebellum|basilar_part_of_pons|pyramidal_part_of_medulla)/i), boxOf(/^VH_F_(sclera|cornea|retina|vitreous)/i))
  const lungs = boxOf(/bronchopulmonary/i)
  const abdomen = unionOf(boxOf(/liver/i), boxOf(/^VH_F_(kidney_capsule|outer_cortex_of_kidney)/i), boxOf(/pancreas/i), boxOf(/spleen/i))
  const pelvis = boxOf(/^VH_F_(ilium|ischium|pubis)_/i)
  const skinBox = boxOf(/^VH_F_skin$/i)
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(skinBox.min[i] - FEMALE_SKIN_BOX.min[i]) > 0.002 || Math.abs(skinBox.max[i] - FEMALE_SKIN_BOX.max[i]) > 0.002) {
      throw new Error(`female skin box changed (${JSON.stringify(skinBox)}); re-measure FEMALE_SKIN_LANDMARKS`)
    }
  }
  return {
    spine, head, lungs, abdomen, pelvis, skinBox,
    femur: { l: [endCentroid(femur.l, 'top'), endCentroid(femur.l, 'bottom')], r: [endCentroid(femur.r, 'top'), endCentroid(femur.r, 'bottom')] },
    tibia: { l: [endCentroid(tibia.l, 'top'), endCentroid(tibia.l, 'bottom')], r: [endCentroid(tibia.r, 'top'), endCentroid(tibia.r, 'bottom')] },
    shoulder: FEMALE_SKIN_LANDMARKS.shoulder,
    elbow: FEMALE_SKIN_LANDMARKS.elbow,
    wrist: FEMALE_SKIN_LANDMARKS.wrist,
    fingertip: FEMALE_SKIN_LANDMARKS.fingertip,
    foot: FEMALE_SKIN_LANDMARKS.foot,
  }
}

function buildRegionMaps(male, female) {
  // Both models: +x is the body's left. Asserted on the femora.
  if (Math.sign(male.femur.l[0][0]) !== Math.sign(female.femur.l[0][0])) throw new Error('models disagree on left/right')
  const level = (name) => male.spine.find((s) => s.name === name).centre[1]
  const ratio = (a, b, i) => boxSize(b)[i] / boxSize(a)[i]
  const scaleLevels = [
    { y: level('coccyx') - 0.05, at: 'below the coccyx (pelvis box)', sx: ratio(male.pelvis, female.pelvis, 0), sz: ratio(male.pelvis, female.pelvis, 2) },
    { y: level('sacrum'), at: 'sacrum (pelvis box)', sx: ratio(male.pelvis, female.pelvis, 0), sz: ratio(male.pelvis, female.pelvis, 2) },
    { y: level('L5'), at: 'L5 (liver, spleen, kidneys, pancreas box)', sx: ratio(male.abdomen, female.abdomen, 0), sz: ratio(male.abdomen, female.abdomen, 2) },
    { y: level('T10'), at: 'T10 (liver, spleen, kidneys, pancreas box)', sx: ratio(male.abdomen, female.abdomen, 0), sz: ratio(male.abdomen, female.abdomen, 2) },
    { y: level('T4'), at: 'T4 (lungs box)', sx: ratio(male.lungs, female.lungs, 0), sz: ratio(male.lungs, female.lungs, 2) },
    { y: level('C4'), at: 'C4 (neck, unscaled)', sx: 1, sz: 1 },
  ].sort((a, b) => a.y - b.y)
  const trunk = trunkWarp({ spine: male.spine, scaleLevels }, { spine: female.spine })
  const head = boxAffine(male.head, female.head)
  const maps = { trunk, head }
  for (const side of ['l', 'r']) {
    maps[`upperarm.${side}`] = similarity(male.shoulder[side], male.elbow[side], female.shoulder[side], female.elbow[side])
    maps[`forearm.${side}`] = similarity(male.elbow[side], male.wrist[side], female.elbow[side], female.wrist[side])
    maps[`hand.${side}`] = similarity(male.wrist[side], male.fingertip[side], female.wrist[side], female.fingertip[side])
    maps[`thigh.${side}`] = similarity(male.femur[side][0], male.femur[side][1], female.femur[side][0], female.femur[side][1])
    maps[`leg.${side}`] = similarity(male.tibia[side][0], male.tibia[side][1], female.tibia[side][0], female.tibia[side][1])
    maps[`foot.${side}`] = boxAffine(male.foot[side], female.foot[side])
  }
  return maps
}

function fitPoint(field, maps, p) {
  const weights = field.query(p)
  const out = [0, 0, 0]
  for (const [cls, w] of weights) {
    const q = (maps[cls] ?? maps.trunk).map(p)
    out[0] += q[0] * w; out[1] += q[1] * w; out[2] += q[2] * w
  }
  return out
}

/** Which male structures of a layer are fitted, and which are left out and why. */
function selectFitted(layerId, maleStructures, femaleNames, aliases) {
  const rules = FIT_RULES[layerId]
  const picked = []
  const omitted = []
  for (const s of maleStructures) {
    if (s.layer !== layerId) continue
    const group = s.group ?? null
    const core = s.name.replace(/ \((left|right)(, [a-z])?\)$/, '')
    if (rules.only && !rules.only.test(core) && !(rules.onlyClasses && rules.onlyClasses.test(patchClass(s.node)))) {
      omitted.push({ node: s.node, reason: 'not fitted', why: rules.onlyWhy })
      continue
    }
    if (rules.never && rules.never.test(core)) {
      omitted.push({ node: s.node, reason: 'never', why: rules.neverWhy })
      continue
    }
    if (rules.omitGroups.includes(group) && !(rules.keepInGroup && rules.keepInGroup.test(s.name))) {
      omitted.push({ node: s.node, reason: `group: ${group ?? 'ungrouped'}`, why: rules.omitGroupsWhy })
      continue
    }
    const eq = femaleEquivalent(s.name, femaleNames)
    if (eq) {
      omitted.push({ node: s.node, reason: 'native', why: `the HRA models it ("${eq}")` })
      continue
    }
    picked.push(s)
  }
  void aliases
  return { picked, omitted }
}

// --------------------------------------------------------------------------
// FEMALE SKIN: feet and hands from the male model, an inside test, hair on the skin
// --------------------------------------------------------------------------
// The Visible Human Female's feet are deformed in the HRA source (plantar-
// flexed, inverted, toes unresolved) and her hands are posed differently
// from the fitted male hand bones (fingers splayed), so below an ANKLE plane
// per leg and a distal-FOREARM plane per arm the HRA skin is cut away and
// the male Terminologia Anatomica skin regions of the foot + leg and hand +
// forearm are fitted in with the same limb maps the fitted bones use, so
// skin and bones share one pose and one fit by construction. Both meshes
// are cut by the same horizontal plane in the female frame; the male rim's
// last SKIN_TAPER metres are tapered radially onto the HRA cut ring, so the
// seam closes (a ring of 72 angular bins, mean radius each).
//
// The uncut HRA skin also gives (a) an inside/outside test on a 1 cm column
// grid (ray parity along z) used to clamp fitted vertices that poke out of
// the skin back to CLAMP_DEPTH inside it, and (b) the nearest-skin-sample
// search used by that clamp and by the hair, whose flat patches (pubic,
// eyebrows, eyelashes) are projected onto the skin and whose head cap is
// shifted to touch the scalp.
// Male heights of the cut planes, mapped per side: just above the ankle patches; mid-forearm
// (a cut nearer the wrist ran through the female's raised thumb and hand, where the
// skin is nearly horizontal and no ring exists).
const SKIN_CUT_MALE_Y = { leg: 0.135, arm: 0.98 }
const SKIN_TAPER = 0.06
const SKIN_ARM_ZONE = { minAbsX: 0.25, minY: -0.2 }
const CLAMP_DEPTH = 0.003
const VOXEL = 0.01
const RING_BINS = 72

function skinPositionsBaked(node) {
  // World-space positions and the index array of the (single-primitive) HRA skin.
  const prim = node.getMesh().listPrimitives()[0]
  const pos = Float32Array.from(prim.getAttribute('POSITION').getArray())
  const m = node.getWorldMatrix()
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12]
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
  }
  const idx = Uint32Array.from(prim.getIndices().getArray())
  return { prim, pos, idx }
}

/** Column grid of z-crossings of a closed mesh: inside(p) by ray parity along +z. */
function buildInsideTest(pos, idx) {
  const columns = new Map()
  const key = (ix, iy) => ix * 100000 + iy
  let tris = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2]
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2]
    const x0 = Math.floor(Math.min(ax, bx, cx) / VOXEL), x1 = Math.floor(Math.max(ax, bx, cx) / VOXEL)
    const y0 = Math.floor(Math.min(ay, by, cy) / VOXEL), y1 = Math.floor(Math.max(ay, by, cy) / VOXEL)
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    if (Math.abs(det) < 1e-12) continue
    tris += 1
    for (let ix = x0; ix <= x1; ix += 1) {
      const px = (ix + 0.5) * VOXEL
      for (let iy = y0; iy <= y1; iy += 1) {
        const py = (iy + 0.5) * VOXEL
        const l1 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det
        const l2 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det
        const l3 = 1 - l1 - l2
        if (l1 < 0 || l2 < 0 || l3 < 0) continue
        const z = l1 * az + l2 * bz + l3 * cz
        const k = key(ix, iy)
        let list = columns.get(k)
        if (!list) { list = []; columns.set(k, list) }
        list.push(z)
      }
    }
  }
  let odd = 0
  for (const list of columns.values()) { list.sort((p, q) => p - q); if (list.length % 2) odd += 1 }
  const inside = (p) => {
    const list = columns.get(key(Math.floor(p[0] / VOXEL), Math.floor(p[1] / VOXEL)))
    if (!list) return false
    let n = 0
    for (const z of list) if (z > p[2]) n += 1
    return n % 2 === 1
  }
  return { inside, columns: columns.size, oddColumns: odd, triangles: tris }
}

/** Nearest skin vertex (2 cm grid, expanding rings). */
function buildNearest(pos) {
  const cell = 0.02
  const grid = new Map()
  const key = (ix, iy, iz) => `${ix},${iy},${iz}`
  for (let i = 0; i < pos.length; i += 3) {
    const k = key(Math.floor(pos[i] / cell), Math.floor(pos[i + 1] / cell), Math.floor(pos[i + 2] / cell))
    let list = grid.get(k)
    if (!list) { list = []; grid.set(k, list) }
    list.push(i)
  }
  return (p) => {
    const ix = Math.floor(p[0] / cell), iy = Math.floor(p[1] / cell), iz = Math.floor(p[2] / cell)
    let best = null, bestD = Infinity
    for (let r = 0; r <= 4; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) for (let dy = -r; dy <= r; dy += 1) for (let dz = -r; dz <= r; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
        const list = grid.get(key(ix + dx, iy + dy, iz + dz))
        if (!list) continue
        for (const i of list) {
          const d = (pos[i] - p[0]) ** 2 + (pos[i + 1] - p[1]) ** 2 + (pos[i + 2] - p[2]) ** 2
          if (d < bestD) { bestD = d; best = [pos[i], pos[i + 1], pos[i + 2]] }
        }
      }
      if (best && bestD < ((r + 1) * cell) ** 2) break
    }
    return best ? { point: best, distance: Math.sqrt(bestD) } : null
  }
}

/** The zones of the female frame that the male skin replaces. */
function makeZones(planes) {
  return {
    leg: (p) => (p[0] >= 0 ? (p[1] < planes.leg.l ? 'l' : null) : p[1] < planes.leg.r ? 'r' : null),
    arm: (p) => {
      if (Math.abs(p[0]) < SKIN_ARM_ZONE.minAbsX || p[1] < SKIN_ARM_ZONE.minY) return null
      return p[0] >= 0 ? (p[1] < planes.arm.l ? 'l' : null) : p[1] < planes.arm.r ? 'r' : null
    },
    any: (p) => makeZones(planes).leg(p) !== null || makeZones(planes).arm(p) !== null,
  }
}

/** Cut planes in the female frame: the male heights mapped through the limb maps, per side. */
function skinCutPlanes(maps, male) {
  const planes = { leg: {}, arm: {} }
  for (const side of ['l', 'r']) {
    const tib = male.tibia[side]
    const legAxis = [tib[0][0], SKIN_CUT_MALE_Y.leg, tib[0][2]]
    planes.leg[side] = maps[`leg.${side}`].map(legAxis)[1]
    const elbow = male.elbow[side], wrist = male.wrist[side]
    const t = (elbow[1] - SKIN_CUT_MALE_Y.arm) / (elbow[1] - wrist[1])
    const armAxis = [0, 1, 2].map((i) => elbow[i] + (wrist[i] - elbow[i]) * t)
    planes.arm[side] = maps[`forearm.${side}`].map(armAxis)[1]
  }
  return planes
}

/** Ring of the HRA skin at a plane inside a zone: centre and mean radius per angular bin. */
function ringAt(pos, y, zoneTest) {
  const pts = []
  for (let i = 0; i < pos.length; i += 3) {
    if (Math.abs(pos[i + 1] - y) > 0.006) continue
    const p = [pos[i], pos[i + 1], pos[i + 2]]
    if (!zoneTest(p)) continue
    pts.push(p)
  }
  if (pts.length < 12) throw new Error(`skin ring at y=${y.toFixed(3)}: only ${pts.length} points`)
  const c = [0, 0]
  for (const p of pts) { c[0] += p[0]; c[1] += p[2] }
  c[0] /= pts.length; c[1] /= pts.length
  // The OUTER radius per bin (max, not mean): where the skin surface runs
  // close to the plane the slab also catches points inside the outline.
  const maxes = new Float64Array(RING_BINS), counts = new Float64Array(RING_BINS)
  for (const p of pts) {
    const a = Math.atan2(p[2] - c[1], p[0] - c[0])
    const b = Math.floor(((a + Math.PI) / (2 * Math.PI)) * RING_BINS) % RING_BINS
    maxes[b] = Math.max(maxes[b], Math.hypot(p[0] - c[0], p[2] - c[1])); counts[b] += 1
  }
  const radius = new Float64Array(RING_BINS)
  for (let b = 0; b < RING_BINS; b += 1) {
    if (counts[b]) { radius[b] = maxes[b]; continue }
    // empty bin: nearest filled neighbours
    let lo = b, hi = b
    while (!counts[lo]) lo = (lo - 1 + RING_BINS) % RING_BINS
    while (!counts[hi]) hi = (hi + 1) % RING_BINS
    radius[b] = (maxes[lo] + maxes[hi]) / 2
  }
  const radiusAt = (x, z) => {
    const a = Math.atan2(z - c[1], x - c[0])
    const f = ((a + Math.PI) / (2 * Math.PI)) * RING_BINS
    const b0 = Math.floor(f) % RING_BINS, b1 = (b0 + 1) % RING_BINS, t = f - Math.floor(f)
    return radius[b0] * (1 - t) + radius[b1] * t
  }
  return { centre: c, radiusAt, points: pts.length, meanRadius: [...radius].reduce((s, v) => s + v, 0) / RING_BINS }
}

/**
 * Cut the HRA skin below the planes (faces whose centroid lies in a zone
 * go; the kept faces' vertices below the plane are lifted onto it so the
 * rim is planar) and return the rings the fitted rims taper to.
 */
function cutFemaleSkin(skin, planes) {
  const { prim, pos, idx } = skin
  const zones = makeZones(planes)
  const kept = []
  let dropped = 0
  const inZone = (v) => { const p = [pos[v], pos[v + 1], pos[v + 2]]; return zones.leg(p) !== null || zones.arm(p) !== null }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    // A face goes only when all three corners are in a zone; a straddling
    // face stays and its in-zone corners are lifted onto the plane below.
    if (inZone(a) && inZone(b) && inZone(c)) { dropped += 1; continue }
    kept.push(idx[t], idx[t + 1], idx[t + 2])
  }
  // Rims: vertices of kept faces that sit below their zone plane are lifted to it.
  const rings = { leg: {}, arm: {} }
  for (const side of ['l', 'r']) {
    rings.leg[side] = ringAt(pos, planes.leg[side], (p) => (p[0] >= 0 ? 'l' : 'r') === side)
    rings.arm[side] = ringAt(pos, planes.arm[side], (p) => Math.abs(p[0]) >= SKIN_ARM_ZONE.minAbsX && p[1] > SKIN_ARM_ZONE.minY && (p[0] >= 0 ? 'l' : 'r') === side)
  }
  const lifted = new Set()
  for (let i = 0; i < kept.length; i += 1) {
    const v = kept[i] * 3
    const p = [pos[v], pos[v + 1], pos[v + 2]]
    const lz = zones.leg(p), az = zones.arm(p)
    if (lz) { pos[v + 1] = planes.leg[lz]; lifted.add(kept[i]) }
    else if (az) { pos[v + 1] = planes.arm[az]; lifted.add(kept[i]) }
  }
  const doc = prim.getAttribute('POSITION').getParent ? null : null
  void doc
  prim.getAttribute('POSITION').setArray(pos)
  prim.getIndices().setArray(kept.length > 65535 ? Uint32Array.from(kept) : Uint32Array.from(kept))
  return { dropped, kept: kept.length / 3, lifted: lifted.size, rings }
}

/** For fitted skin patches of the limbs: cut above the plane, taper the rim onto the HRA ring. */
function cutAndTaperFittedPatch(arr, indices, planes, rings, cls) {
  const kind = cls.startsWith('foot') || cls.startsWith('leg') ? 'leg' : 'arm'
  const side = cls.endsWith('.l') ? 'l' : 'r'
  const Y = planes[kind][side]
  const ring = rings[kind][side]
  const kept = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
    if (arr[a + 1] > Y && arr[b + 1] > Y && arr[c + 1] > Y) continue
    kept.push(indices[t], indices[t + 1], indices[t + 2])
  }
  const used = new Set(kept)
  let tapered = 0
  for (const vi of used) {
    const v = vi * 3
    if (arr[v + 1] > Y) arr[v + 1] = Y
    const t = (arr[v + 1] - (Y - SKIN_TAPER)) / SKIN_TAPER
    if (t <= 0) continue
    const dx = arr[v] - ring.centre[0], dz = arr[v + 2] - ring.centre[1]
    const r = Math.hypot(dx, dz)
    if (r < 1e-6) continue
    const R = ring.radiusAt(arr[v], arr[v + 2])
    const r2 = r + Math.min(1, t) * (R - r)
    arr[v] = ring.centre[0] + (dx / r) * r2
    arr[v + 2] = ring.centre[1] + (dz / r) * r2
    tapered += 1
  }
  return { kept, tapered }
}

async function buildFemaleFittedLayer(io, layerId, maleStructures, femaleNames, field, maps, aliases, skinAux) {
  const { picked, omitted } = selectFitted(layerId, maleStructures, femaleNames, aliases)
  if (picked.length === 0) return null
  const src = await io.read(join(OUT, `male-${layerId}.glb`))
  await src.transform(dequantize())
  const wanted = new Set(picked.map((s) => s.node))
  const nodes = src.getRoot().listNodes().filter((n) => n.getMesh() && wanted.has(n.getName()))
  if (nodes.length !== picked.length) throw new Error(`${layerId}: ${picked.length} structures picked, ${nodes.length} nodes found in male-${layerId}.glb`)
  const out = new Document()
  out.createBuffer()
  const scene = out.createScene(`female-${layerId}-fitted`)
  const copied = copyToDocument(out, src, nodes)
  const structures = []
  let before = 0
  let moved = 0
  const post = { clamped: 0, unresolved: 0, tapered: 0, hairProjected: 0, hairShift: {}, emptied: [] }
  const HAIR_FLAT = /^(Hairs of eyebrow|Eyelashes|Pubic hairs)/
  for (const node of nodes) {
    const target = copied.get(node)
    scene.addChild(target)
    const cls = layerId === 'skin' ? patchClass(node.getName()) : null
    const limbPatch = cls !== null && /^(foot|leg|hand|forearm)\./.test(cls)
    const isHair = layerId === 'skin' && /^(Hairs of head|Hairs of eyebrow|Eyelashes|Pubic hairs)/.test(node.getName())
    // The male files keep ONE mesh for a mirrored pair (the right side is
    // the left mesh under a mirroring node matrix), so every node gets its
    // own mesh with its own fitted positions; the shared one is pruned.
    const world = node.getWorldMatrix()
    const shared = target.getMesh()
    const own = out.createMesh(shared.getName())
    for (const prim of shared.listPrimitives()) {
      const acc = prim.getAttribute('POSITION')
      const arr = Float32Array.from(acc.getArray())
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2]
        const w = [world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14]]
        const q = fitPoint(field, maps, w)
        arr[i] = q[0]; arr[i + 1] = q[1]; arr[i + 2] = q[2]
        moved += 1
      }
      let indexAcc = prim.getIndices()
      if (limbPatch) {
        // Feet and hands: cut above the plane, taper the rim onto the HRA ring.
        const r = cutAndTaperFittedPatch(arr, indexAcc.getArray(), skinAux.planes, skinAux.rings, cls)
        post.tapered += r.tapered
        if (r.kept.length === 0) { indexAcc = null } else {
          indexAcc = out.createAccessor().setType('SCALAR').setArray(Uint32Array.from(r.kept)).setBuffer(out.getRoot().listBuffers()[0])
        }
      } else if (isHair) {
        if (HAIR_FLAT.test(node.getName())) {
          // A flat patch lies ON the skin: every vertex to its nearest skin point, 1.5 mm out.
          for (let i = 0; i < arr.length; i += 3) {
            const v = [arr[i], arr[i + 1], arr[i + 2]]
            const n = skinAux.nearest(v)
            if (!n) continue
            const d = [v[0] - n.point[0], v[1] - n.point[1], v[2] - n.point[2]]
            const len2 = Math.hypot(d[0], d[1], d[2]) || 1
            const outward = skinAux.inside(v) ? -1 : 1
            arr[i] = n.point[0] + (d[0] / len2) * 0.0015 * outward
            arr[i + 1] = n.point[1] + (d[1] / len2) * 0.0015 * outward
            arr[i + 2] = n.point[2] + (d[2] / len2) * 0.0015 * outward
            post.hairProjected += 1
          }
        } else {
          // The head cap keeps its volume: shifted as a whole so its nearest point touches the scalp.
          let minGap = Infinity, dir = [0, 0, 0]
          for (let i = 0; i < arr.length; i += 3) {
            const v = [arr[i], arr[i + 1], arr[i + 2]]
            if (skinAux.inside(v)) { minGap = 0; break }
            const n = skinAux.nearest(v)
            if (n && n.distance < minGap) { minGap = n.distance; dir = [n.point[0] - v[0], n.point[1] - v[1], n.point[2] - v[2]] }
          }
          if (minGap > 0.002 && minGap < Infinity) {
            const l = Math.hypot(...dir) || 1
            const shift = (minGap - 0.001)
            for (let i = 0; i < arr.length; i += 3) { arr[i] += (dir[0] / l) * shift; arr[i + 1] += (dir[1] / l) * shift; arr[i + 2] += (dir[2] / l) * shift }
            post.hairShift[node.getName()] = Number(shift.toFixed(4))
          }
        }
      } else if (layerId !== 'skin') {
        // Anything outside the female skin (and not in the replaced feet/hands zones)
        // is pulled back to CLAMP_DEPTH inside it along the nearest-skin direction.
        for (let i = 0; i < arr.length; i += 3) {
          const v = [arr[i], arr[i + 1], arr[i + 2]]
          if (skinAux.zones.leg(v) || skinAux.zones.arm(v)) continue
          if (skinAux.inside(v)) continue
          const n = skinAux.nearest(v)
          if (!n || n.distance < 0.002) continue
          const d = [n.point[0] - v[0], n.point[1] - v[1], n.point[2] - v[2]]
          const l = Math.hypot(d[0], d[1], d[2]) || 1
          let placed = false
          for (const depth of [CLAMP_DEPTH, CLAMP_DEPTH * 2, CLAMP_DEPTH * 4]) {
            const q = [n.point[0] + (d[0] / l) * depth, n.point[1] + (d[1] / l) * depth, n.point[2] + (d[2] / l) * depth]
            if (skinAux.inside(q)) { arr[i] = q[0]; arr[i + 1] = q[1]; arr[i + 2] = q[2]; placed = true; break }
          }
          if (placed) post.clamped += 1
          else post.unresolved += 1
        }
      }
      const fittedAcc = out.createAccessor().setType('VEC3').setArray(arr).setBuffer(out.getRoot().listBuffers()[0])
      if (!indexAcc) continue
      const ownPrim = out.createPrimitive().setMode(prim.getMode()).setIndices(indexAcc).setAttribute('POSITION', fittedAcc)
      own.addPrimitive(ownPrim)
    }
    if (own.listPrimitives().length === 0) {
      // A limb patch entirely above its cut plane: nothing of it is used.
      post.emptied.push(node.getName())
      target.setMesh(null)
      target.dispose()
      continue
    }
    target.setMesh(own)
    // A mirrored copy has inverted winding: flip it so the normals face out.
    const det = world[0] * (world[5] * world[10] - world[9] * world[6]) - world[4] * (world[1] * world[10] - world[9] * world[2]) + world[8] * (world[1] * world[6] - world[5] * world[2])
    if (det < 0) {
      for (const prim of own.listPrimitives()) {
        const idx = prim.getIndices()
        if (!idx) continue
        const ia = idx.getArray().slice()
        for (let i = 0; i + 2 < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t }
        prim.setIndices(out.createAccessor().setType('SCALAR').setArray(ia).setBuffer(out.getRoot().listBuffers()[0]))
      }
    }
    target.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    before += triangleCount(target)
    const entry = picked.find((s) => s.node === node.getName())
    structures.push({ node: entry.node, layer: layerId, name: entry.name, latin: entry.latin ?? null, system: entry.system, group: entry.group, organ: entry.organ, fitted: 'male' })
  }
  for (const name of post.emptied) omitted.push({ node: name, reason: 'not fitted', why: 'a limb skin patch that lies wholly above the cut plane; the HRA skin covers it' })
  await out.transform(unpartition(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14 }))
  const after = new Map(out.getRoot().listNodes().map((node) => [node.getName(), triangleCount(node)]))
  for (const s of structures) s.triangles = after.get(s.node) ?? 0
  const bytes = Buffer.from(await io.writeBinary(out))
  // The organs layer already has the section-65.9 file (stomach and oesophagus).
  const suffix = layerId === 'organs' ? '-fitted-more' : '-fitted'
  const file = `female-${layerId}${suffix}.glb`
  writeFileSync(join(OUT, file), bytes)
  const tris = [...after.values()].reduce((a, b) => a + b, 0)
  log(`${file}: ${structures.length} structures fitted (${omitted.length} male structures left out), ${moved.toLocaleString()} vertices, ${tris.toLocaleString()} triangles, ${(bytes.length / 1e6).toFixed(2)} MB; clamped inside the skin ${post.clamped.toLocaleString()} (${post.unresolved} unresolved), rim vertices tapered ${post.tapered}, hair vertices projected ${post.hairProjected}, patches emptied ${post.emptied.length}`)
  const omitSummary = new Map()
  for (const o of omitted) {
    const k = o.reason.startsWith('native') ? 'native' : o.reason
    const cur = omitSummary.get(k) ?? { what: k === 'native' ? 'the HRA models it natively' : k, count: 0, why: o.why, examples: [] }
    cur.count += 1
    if (cur.examples.length < 12) cur.examples.push(o.node)
    omitSummary.set(k, cur)
  }
  return {
    supplement: {
      id: `${layerId}${suffix}`,
      layer: layerId,
      file: `anatomy/models/${file}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      structures: structures.length,
      triangles: tris,
      sourceTriangles: before,
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      note: `${structures.length} structures the HRA does not model, fitted from the male Z-Anatomy model by the region field (position indicative)`,
      omitted: [...omitSummary.values()],
      clampedInsideSkin: layerId === 'skin' ? undefined : { moved: post.clamped, unresolved: post.unresolved, depthMetres: CLAMP_DEPTH },
      skinReplacement: layerId === 'skin' ? { planes: skinAux.planes, taperMetres: SKIN_TAPER, rimVerticesTapered: post.tapered, hairVerticesProjected: post.hairProjected, headHairShiftMetres: post.hairShift, patchesEmptied: post.emptied, hraSkinCut: skinAux.cut } : undefined,
    },
    structures,
    omitted,
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  mkdirSync(OUT, { recursive: true })
  const reference = JSON.parse(readFileSync(REFERENCE, 'utf-8'))
  const aliases = compileAliases(reference.organs)
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
  })
  await MeshoptEncoder.ready
  await MeshoptDecoder.ready
  await MeshoptSimplifier.ready

  const only = process.argv.includes('--female') ? ['female'] : process.argv.includes('--male') ? ['male'] : ['male', 'female']
  const results = []
  if (only.includes('male')) results.push(await buildMale(io, aliases))
  if (only.includes('female')) {
    const female = await buildFemale(io, aliases)
    const maleStructures = results.find((r) => r.sex === 'male')?.structures
      ?? JSON.parse(readFileSync(join(OUT, 'structures-male.json'), 'utf-8')).structures
    const fitted = await buildFemaleFitted(io, female.landmarks, maleStructures)
    delete female.landmarks
    female.layers.find((l) => l.id === 'organs').supplements = [fitted.supplement]
    female.structures.push(...fitted.structures)
    // Round 13: everything else the HRA lacks, by the region field.
    log('female: building the region field from the male skin')
    const maleLm = female.maleLm
    const maps = female.maps
    const skinAux = female.skinAux
    delete female.regionLandmarks
    delete female.maleLm
    delete female.maps
    delete female.skinAux
    const field = buildRegionField(maleLm.skinNodes)
    log(`female: region field over ${field.samples.toLocaleString()} male skin samples`)
    const femaleNames = new Set()
    for (const s of female.structures) for (const n of [s.name, s.derived, s.hraLabel]) if (n) femaleNames.add(normaliseName(n))
    const fittedByLayer = {}
    for (const layer of LAYERS) {
      const r = await buildFemaleFittedLayer(io, layer.id, maleStructures, femaleNames, field, maps, aliases, skinAux)
      if (!r) continue
      const rec = female.layers.find((l) => l.id === layer.id)
      rec.supplements = [...(rec.supplements ?? []), r.supplement]
      female.structures.push(...r.structures)
      fittedByLayer[layer.id] = r
    }
    // Fit report for the decisions draft: every male structure left out, and why.
    const fitLines = ['# Anatomy female fit report (round 13)', '', `Generated ${new Date().toISOString()} by scripts/build-anatomy-models.mjs`, '']
    for (const [id, r] of Object.entries(fittedByLayer)) {
      fitLines.push(`## ${id}: ${r.structures.length} fitted, ${r.omitted.length} left out`, '')
      const byReason = new Map()
      for (const o of r.omitted) { const k = o.reason.startsWith('native') ? 'native' : o.reason; if (!byReason.has(k)) byReason.set(k, []); byReason.get(k).push(o.reason.startsWith('native') ? `${o.node} = ${o.why.replace(/^the HRA models it \("(.*)"\)$/, '$1')}` : o.node) }
      for (const [k, list] of byReason) fitLines.push(`- ${k} (${list.length}): ${list.sort().join(' | ')}`, '')
    }
    fitLines.push('## Maps', '', '```json', JSON.stringify(Object.fromEntries(Object.entries(maps).map(([k, v]) => [k, v.meta])), null, 1), '```', '')
    mkdirSync(dirname(REPORT), { recursive: true })
    writeFileSync(join(dirname(REPORT), 'anatomy-fit-report.md'), fitLines.join('\n') + '\n')
    for (const rec of female.layers) {
      const r = fittedByLayer[rec.id]
      const summary = FITTED_SUMMARY[rec.id]
      rec.note = r
        ? `${rec.native}; fitted from the male model and labelled so: ${summary} (${r.supplement.structures} structures)`
        : rec.id === 'organs'
          ? `${rec.native}; the stomach and oesophagus are fitted from the male model (the HRA has neither for either sex) and labelled so`
          : rec.native
      delete rec.native
    }
    female.supplements = [fitted.source, {
      id: 'z-anatomy-fitted-region',
      title: 'Skeleton, nerves, vessels, muscles, glands and hair the HRA lacks, fitted from the male model',
      author: 'Z-Anatomy (after BodyParts3D, DBCLS), via the Anatria3D GLB export; fitted into the female body for this site by a region field',
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      sourcePage: ANATRIA_PAGE,
      upstream: [
        { title: 'Z-Anatomy, the libre 3D atlas of anatomy', url: 'https://www.z-anatomy.com/', licence: 'CC BY-SA 4.0' },
        { title: 'BodyParts3D, Database Center for Life Science (DBCLS), Japan', url: 'https://lifesciencedb.jp/bp3d/', licence: 'CC BY-SA 2.1 JP' },
      ],
      pinned: { repository: 'https://github.com/Nurkan1/Anatria-3D', commit: ANATRIA_COMMIT },
      notice: 'anatomy/models/NOTICE-male.txt',
      why: 'no free female whole-body skeleton, muscle, nerve or vessel set exists (2026-09-19 search: the HRA united-female has only the spine, pelvis, knees, brain, cord, eyes, heart and trunk vessels); the male structures are fitted region-wise so that every layer is complete, and each is marked as fitted',
      fit: {
        method: 'region field: each male vertex takes the classes of its nearest male skin patches (Terminologia Anatomica regions, Gaussian weights) and is moved by the blend of the class maps; trunk = piecewise-linear height through matched vertebra centres with width/depth scaled about the spine per level; head = per-axis affine of the brain+eyes box; limbs = similarity (rotation + uniform scale) of each segment axis (femur and tibia from the bones both models have; upper arm, forearm, hand and the feet from landmarks measured on the female skin silhouette)',
        sigmaMetres: FIT_SIGMA,
        maps: Object.fromEntries(Object.entries(maps).map(([k, v]) => [k, v.meta])),
        femaleSkinLandmarks: FEMALE_SKIN_LANDMARKS,
      },
      files: MALE_FILES.map((name) => ({ file: name, url: ANATRIA_RAW + name, bytes: readFileSync(join(CACHE, name)).length, sha256: sha256(readFileSync(join(CACHE, name))) })),
    }]
    results.push(female)
  }

  // Keep the untouched sex from the previous manifest when building one only.
  let previous = null
  const manifestPath = join(OUT, 'manifest.json')
  if (existsSync(manifestPath)) previous = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const sexes = {}
  for (const sex of ['male', 'female']) {
    const built = results.find((r) => r.sex === sex)
    if (built) {
      const { structures, ...rest } = built
      const layerBytes = (l) => l.bytes + (l.supplements ?? []).reduce((sum, s) => sum + s.bytes, 0)
      sexes[sex] = { ...rest, totalBytes: rest.layers.reduce((sum, l) => sum + layerBytes(l), 0), structureCount: structures.length }
      writeFileSync(join(OUT, `structures-${sex}.json`), JSON.stringify({ sex, structures }) + '\n')
    } else if (previous?.sexes?.[sex]) {
      sexes[sex] = previous.sexes[sex]
    }
  }

  let failures = 0
  for (const [sex, record] of Object.entries(sexes)) {
    for (const layer of record.layers) {
      if (layer.bytes > LAYER_BUDGET) {
        failures += 1
        console.error(`  FAIL  ${layer.file}: ${(layer.bytes / 1e6).toFixed(2)} MB over the ${LAYER_BUDGET / 1e6} MB layer budget`)
      }
    }
    if (record.totalBytes > SEX_BUDGET) {
      failures += 1
      console.error(`  FAIL  ${sex}: ${(record.totalBytes / 1e6).toFixed(2)} MB over the ${SEX_BUDGET / 1e6} MB budget`)
    }
    log(`${sex}: ${(record.totalBytes / 1e6).toFixed(2)} MB across ${record.layers.length} layers, ${record.structureCount} structures`)
  }

  const manifest = {
    version: 1,
    generatedBy: 'scripts/build-anatomy-models.mjs',
    note: 'One registered free model per sex, split into six layers ordered bone to flesh. Every structure is a named node; structures-<sex>.json maps node -> name, system and the site organ entry it opens. Licences: male CC BY-SA 4.0 (share-alike: these GLBs are adaptations and stay CC BY-SA 4.0), female CC BY 4.0 except the fitted supplement file (stomach and oesophagus from the male model, CC BY-SA 4.0, labelled as fitted). Attribution is rendered on the page per sex.',
    budgets: { layerBytes: LAYER_BUDGET, sexBytes: SEX_BUDGET },
    layers: LAYERS.map(({ id, label }, index) => ({ id, label, order: index + 1 })),
    encoding: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    sexes,
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  // Alias report for the decisions draft: every organ -> the node names it opens from.
  const lines = ['# Anatomy 3-D alias report', '', `Generated ${new Date().toISOString()} by scripts/build-anatomy-models.mjs`, '']
  for (const sex of ['male', 'female']) {
    const built = results.find((r) => r.sex === sex)
    if (!built) continue
    lines.push(`## ${sex}`, '')
    const byOrgan = new Map()
    for (const s of built.structures) {
      const key = s.organ ?? '(no entry)'
      if (!byOrgan.has(key)) byOrgan.set(key, [])
      byOrgan.get(key).push(s)
    }
    for (const organ of reference.organs) {
      const list = byOrgan.get(organ.id) ?? []
      lines.push(`### ${organ.id} — ${organ.name}: ${list.length} node(s)`)
      const names = [...new Set(list.map((s) => s.name.replace(/ \((left|right)(, [a-z])?\)$/, '')))].sort()
      lines.push(names.length ? names.join(' | ') : '(none in this model)')
      lines.push('')
    }
    const none = byOrgan.get('(no entry)') ?? []
    lines.push(`### Structures with no site entry: ${none.length}`)
    const byLayer = new Map()
    for (const s of none) {
      if (!byLayer.has(s.layer)) byLayer.set(s.layer, new Set())
      byLayer.get(s.layer).add(s.name.replace(/ \((left|right)(, [a-z])?\)$/, ''))
    }
    for (const [layer, names] of byLayer) lines.push(`- ${layer} (${names.size}): ${[...names].sort().join(' | ')}`)
    lines.push('')
  }
  mkdirSync(dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, lines.join('\n') + '\n')

  if (failures) {
    console.error(`\nFAIL — ${failures} budget problem(s).`)
    process.exit(1)
  }
  log('done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
