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

import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, dedup, flatten, meshopt, prune, simplify, unpartition, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'

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
const FEMALE_COVERAGE = {
  skeleton: { coverage: 'partial', note: 'vertebral column, sacrum, pelvis and the bones of the knee only; the HRA models no skull, rib cage or limb bones' },
  nervous: { coverage: 'partial', note: 'brain (Allen Human Brain Atlas regions), spinal cord, eyes and the nerves of the eye; no peripheral nerves' },
  organs: { coverage: 'full', note: 'digestive, urinary, respiratory, lymphatic and reproductive organs and the mammary glands' },
  vessels: { coverage: 'partial', note: 'heart and the major blood vessels of the trunk; no lymphatic vessels beyond one lymph node' },
  muscles: { coverage: 'partial', note: 'the HRA models only the muscles of the eye and knee; no skeletal musculature' },
  skin: { coverage: 'full', note: 'the whole-body skin surface' },
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
  })
  await MeshoptEncoder.ready
  await MeshoptSimplifier.ready

  const only = process.argv.includes('--female') ? ['female'] : process.argv.includes('--male') ? ['male'] : ['male', 'female']
  const results = []
  if (only.includes('male')) results.push(await buildMale(io, aliases))
  if (only.includes('female')) results.push(await buildFemale(io, aliases))

  // Keep the untouched sex from the previous manifest when building one only.
  let previous = null
  const manifestPath = join(OUT, 'manifest.json')
  if (existsSync(manifestPath)) previous = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const sexes = {}
  for (const sex of ['male', 'female']) {
    const built = results.find((r) => r.sex === sex)
    if (built) {
      const { structures, ...rest } = built
      sexes[sex] = { ...rest, totalBytes: rest.layers.reduce((sum, l) => sum + l.bytes, 0), structureCount: structures.length }
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
    note: 'One registered free model per sex, split into six layers ordered bone to flesh. Every structure is a named node; structures-<sex>.json maps node -> name, system and the site organ entry it opens. Licences: male CC BY-SA 4.0 (share-alike: these GLBs are adaptations and stay CC BY-SA 4.0), female CC BY 4.0. Attribution is rendered on the page per sex.',
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
