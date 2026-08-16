/**
 * Decorative icons for categorical data: biomes, GDP sectors, Factbook
 * industries and agricultural products, and religions.
 *
 * Emoji, deliberately: they ship with the platform (no icon font, no SVG
 * sprite in the bundle), render in every browser, and keep one consistent
 * illustrated style. They are ALWAYS decoration — aria-hidden at the call
 * site, never the only carrier of meaning, and a missing match renders no
 * icon rather than a wrong one.
 */

/** RESOLVE Ecoregions 2017 biome names, matched exactly. */
const BIOME_ICONS: Record<string, string> = {
  'Boreal Forests/Taiga': '🌲',
  'Deserts & Xeric Shrublands': '🏜️',
  'Flooded Grasslands & Savannas': '🪷',
  Mangroves: '🌿',
  'Mediterranean Forests, Woodlands & Scrub': '🫒',
  'Montane Grasslands & Shrublands': '⛰️',
  'Rock, ice and inland water': '🧊',
  'Temperate Broadleaf & Mixed Forests': '🌳',
  'Temperate Conifer Forests': '🌲',
  'Temperate Grasslands, Savannas & Shrublands': '🌾',
  'Tropical & Subtropical Coniferous Forests': '🌲',
  'Tropical & Subtropical Dry Broadleaf Forests': '🍂',
  'Tropical & Subtropical Grasslands, Savannas & Shrublands': '🦒',
  'Tropical & Subtropical Moist Broadleaf Forests': '🌴',
  Tundra: '❄️',
}

export function biomeIcon(name: string): string | null {
  return BIOME_ICONS[name] ?? null
}

/** GDP value-added sectors. */
const SECTOR_ICONS: Record<string, string> = {
  Agriculture: '🌾',
  Industry: '🏭',
  Services: '💼',
}

export function sectorIcon(label: string): string | null {
  return SECTOR_ICONS[label] ?? null
}

/**
 * Keyword rules for Factbook industry and agricultural-product items.
 * First match wins, so specific rules must precede general ones
 * ("sugar beets" before "beet", "palm oil" before "oil").
 */
const PRODUCT_RULES: [RegExp, string][] = [
  // -- agricultural products ----------------------------------------------
  [/\bmilk|dairy\b/, '🥛'],
  [/\brice\b/, '🍚'],
  [/\bwheat|barley|oats?|sorghum|millet|rye|grain|cereal/, '🌾'],
  [/\bmaize|corn\b/, '🌽'],
  [/sugar ?cane|sugar ?beet|\bsugar\b/, '🍬'],
  [/\bpotato/, '🥔'],
  [/\btomato/, '🍅'],
  [/\bbanana|plantain/, '🍌'],
  [/\bcoffee\b/, '☕'],
  [/\btea\b/, '🍵'],
  [/\bcocoa\b/, '🍫'],
  [/\bcotton\b/, '🧵'],
  [/\bbeef|cattle|buffalo/, '🐄'],
  [/\bpork|pig|swine\b/, '🐖'],
  [/\bpoultry|chicken\b/, '🐓'],
  [/\begg/, '🥚'],
  [/\bfish|seafood|shrimp|prawn|tuna|crustacean|aquaculture/, '🐟'],
  [/\bsheep|mutton|lamb|wool\b/, '🐑'],
  [/\bgoat/, '🐐'],
  [/\bcamel/, '🐪'],
  [/\bgrape|wine\b/, '🍇'],
  [/\bapple/, '🍎'],
  [/\borange|citrus|lemon|lime|grapefruit|tangerine/, '🍊'],
  [/\bolive/, '🫒'],
  [/\bsoy|bean|pulse|legume|lentil|chickpea/, '🫘'],
  [/\bnut|cashew|almond|pistachio|groundnut|peanut/, '🥜'],
  [/palm oil|oil palm|\bcoconut|copra\b/, '🥥'],
  [/\bdate/, '🌴'],
  [/\bcassava|yam|taro|sweet potato|root/, '🍠'],
  [/\bvegetable|cabbage|lettuce|cucumber/, '🥬'],
  [/\bonion/, '🧅'],
  [/\bgarlic/, '🧄'],
  [/\bpepper|chil/, '🌶️'],
  [/\bmango|papaya|pineapple|fruit/, '🥭'],
  [/\bhoney/, '🍯'],
  [/\btobacco/, '🍂'],
  [/\brubber/, '🌳'],
  [/\btimber|lumber|\bwood\b|forestry/, '🪵'],
  [/\bsunflower|rapeseed|sesame|oilseed/, '🌻'],
  [/\bspice|vanilla|clove|cinnamon|cardamom|turmeric|nutmeg|saffron/, '🌿'],
  [/\bginger\b/, '🫚'],
  [/\blivestock|\bcattle ranching/, '🐄'],
  [/\bhorse/, '🐎'],
  [/\bdonkey|mule/, '🫏'],
  [/\bseaweed|algae/, '🌿'],
  [/\bpearl/, '🦪'],
  [/\bsalt\b/, '🧂'],
  [/\bflower|horticulture/, '💐'],
  [/\bcork\b/, '🪵'],
  [/\btomato paste|canned/, '🥫'],
  // -- industries ----------------------------------------------------------
  [/consumer goods|consumer products/, '🛒'],
  [/\bcars?\b|motor vehicle/, '🚗'],
  [/petroleum|crude|\boil\b|refin/, '🛢️'],
  [/natural gas|\bgas\b|lng/, '🔥'],
  [/\bmining|\bore\b|coal|bauxite|phosphate/, '⛏️'],
  [/\bgold\b/, '🪙'],
  [/diamond|gem/, '💎'],
  [/steel|iron|metallurgy|aluminum|aluminium|copper|smelt|metal/, '⚙️'],
  [/textile|garment|apparel|clothing|footwear|leather/, '🧵'],
  [/food processing|food and beverage|beverage|brewing/, '🥫'],
  [/tourism|hospitality/, '🧳'],
  [/bank|financial|finance|insurance/, '🏦'],
  [/pharmaceutical/, '💊'],
  [/chemical|fertilizer|fertiliser|petrochemical/, '🧪'],
  [/electronic|semiconductor|computer|software|information technology|telecom/, '💻'],
  [/automobile|vehicle|motor|automotive/, '🚗'],
  [/shipbuilding|\bship\b|maritime|port/, '🚢'],
  [/aircraft|aerospace|aviation/, '✈️'],
  [/machinery|equipment|engineering/, '⚙️'],
  [/construction|cement|brick/, '🏗️'],
  [/energy|power|electricity|hydroelectric|solar|wind/, '⚡'],
  [/paper|pulp|printing/, '📄'],
  [/plastic/, '🧴'],
  [/transport|logistics|shipping/, '🚚'],
  [/real estate/, '🏘️'],
  [/retail|trade|commerce/, '🛍️'],
  [/remittance/, '💸'],
  [/defen[cs]e|arms|weapons/, '🛡️'],
  [/agricult|farming|agro/, '🌾'],
  [/\bfurniture\b/, '🪑'],
  [/\bjewel|gemstone cutting/, '💍'],
  [/\bwatch(es)?\b|clock/, '⌚'],
  [/\btoys?\b/, '🧸'],
  [/\bglass\b/, '🪟'],
  [/\bcarpet|rug ?weav|handicraft|weaving|embroider/, '🧶'],
  [/\bmedical (?:equipment|instrument|device)|optical|precision instrument/, '🩺'],
  [/\buranium/, '☢️'],
  [/\brum\b|spirits|distill|whisk|vodka|liquor/, '🥃'],
  [/\bbeer|brewer/, '🍺'],
  [/\bcigarette|cigar\b/, '🚬'],
  [/\bfootwear|shoes?\b/, '👟'],
  [/\bsoap|cosmetic|perfume/, '🧴'],
  [/\belectrical (?:appliance|equipment)|household appliance/, '🔌'],
  [/\bsatellite|space\b/, '🛰️'],
  [/\bgambling|casino/, '🎰'],
  [/\bmovie|film|entertainment|media/, '🎬'],
  [/\bcall cent|business process|outsourc/, '📞'],
  [/\beducation\b/, '🎓'],
  [/\brailway|locomotive/, '🚆'],
  [/\bboat ?building|yacht/, '⛵'],
]

/**
 * Display renames for individual list items, applied AT RENDER only -- the
 * committed artifact keeps the source wording. Keys are lowercase.
 */
const ITEM_RENAMES: Record<string, string> = {
  cars: 'motor vehicles',
}

export function itemDisplayName(item: string): string {
  return ITEM_RENAMES[item.toLowerCase()] ?? item
}

export function productIcon(item: string): string | null {
  const needle = item.toLowerCase()
  for (const [pattern, icon] of PRODUCT_RULES) {
    if (pattern.test(needle)) return icon
  }
  return null
}

/** Religion keyword rules; first match wins. */
const RELIGION_RULES: [RegExp, string][] = [
  [/catholic|christian|protestant|orthodox|anglican|evangelical|methodist|baptist|lutheran|presbyterian|pentecostal|adventist|church|mormon|latter[- ]day/, '✝️'],
  [/muslim|islam|sunni|shia|shi'a|ibadhi/, '☪️'],
  [/jewish|judaism/, '✡️'],
  [/hindu/, '🕉️'],
  [/buddhis/, '☸️'],
  [/sikh/, '🪯'],
  [/shinto/, '⛩️'],
  [/tao|daois|confucian|chinese folk/, '☯️'],
  [/baha'?i/, '✴️'],
  [/folk|animis|traditional|indigenous|spiritis|vodou|voodoo|shaman/, '🪘'],
  [/\bnone\b|atheis|agnosti|unaffiliated|no religion|secular/, '⚪'],
  // Catch-alls LAST: "Other Christian" must match the Christian rule above
  // before "other" can claim it.
  [/unspecified|don'?t know|refused|no answer|undeclared|\bother\b|smaller categories/, '❓'],
]

export function religionIcon(label: string): string | null {
  const needle = label.toLowerCase()
  for (const [pattern, icon] of RELIGION_RULES) {
    if (pattern.test(needle)) return icon
  }
  return null
}
