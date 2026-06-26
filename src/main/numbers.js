// Spell out integer numbers as words before TTS (the models read bare digits poorly,
// especially in ru/uk). Nominative cardinal; handles gender for 1/2 and the Slavic
// plural forms of the scale words (тысяча/тысячи/тысяч). en is straightforward.

const RU = {
  ones: ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
  onesF: ['ноль', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
  teens: ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
  tens: ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'],
  hundreds: ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'],
  // [one, few, many, feminine?]
  scales: [null, ['тысяча', 'тысячи', 'тысяч', true], ['миллион', 'миллиона', 'миллионов', false], ['миллиард', 'миллиарда', 'миллиардов', false], ['триллион', 'триллиона', 'триллионов', false]]
}

const UK = {
  ones: ['нуль', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"],
  onesF: ['нуль', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"],
  teens: ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"],
  tens: ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"],
  hundreds: ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"],
  scales: [null, ['тисяча', 'тисячі', 'тисяч', true], ['мільйон', 'мільйони', 'мільйонів', false], ['мільярд', 'мільярди', 'мільярдів', false], ['трильйон', 'трильйони', 'трильйонів', false]]
}

const EN = {
  ones: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
  teens: ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'],
  tens: ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'],
  scales: ['', 'thousand', 'million', 'billion', 'trillion']
}

const DATA = { ru: RU, uk: UK, en: EN }

// Slavic plural form index for the scale word: 0=one, 1=few(2-4), 2=many
function slavicForm(n) {
  const m100 = n % 100
  const m10 = n % 10
  if (m10 === 1 && m100 !== 11) return 0
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 1
  return 2
}

// 0..999 → words; `fem` uses feminine 1/2 (for the thousands group)
function triplet(n, d, fem) {
  const out = []
  const h = Math.floor(n / 100)
  const rest = n % 100
  if (h) out.push(d.hundreds[h])
  if (rest >= 10 && rest <= 19) {
    out.push(d.teens[rest - 10])
  } else {
    const t = Math.floor(rest / 10)
    const u = rest % 10
    if (t >= 2) out.push(d.tens[t])
    if (u) out.push((fem && d.onesF ? d.onesF : d.ones)[u])
  }
  return out
}

function spell(num, lang) {
  const d = DATA[lang]
  if (!d) return String(num)
  if (num === 0) return d.ones[0]
  if (num < 0) return ''
  // split into groups of three (least significant first)
  const groups = []
  let x = num
  while (x > 0) {
    groups.push(x % 1000)
    x = Math.floor(x / 1000)
  }
  if (groups.length > 4) return String(num) // beyond trillions → leave as digits
  const words = []
  for (let g = groups.length - 1; g >= 0; g--) {
    const val = groups[g]
    if (!val) continue
    const scale = d.scales[g]
    if (lang === 'en') {
      words.push(...triplet(val, d, false))
      if (g > 0 && scale) words.push(scale)
    } else {
      const fem = !!(scale && scale[3])
      words.push(...triplet(val, d, fem))
      if (g > 0 && scale) words.push(scale[slavicForm(val)])
    }
  }
  return words.join(' ')
}

// Replace standalone integer runs in `text` with their spelled-out words (ru/uk/en).
export function numbersToWords(text, lang) {
  if (!text || !DATA[lang]) return text
  return text.replace(/\d+/g, (m) => {
    if (m.length > 15) return m // too big to spell meaningfully
    return spell(parseInt(m, 10), lang)
  })
}
