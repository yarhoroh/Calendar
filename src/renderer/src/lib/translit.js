// Cyrillic → Latin so a name typed/spoken in Russian/Ukrainian ("Ирина Дудина") matches a
// contact whose name/email is Latin ("Irina Dudina <irina.dudina@…>"). Both the query and
// each contact go through the same transliteration, so matching works whichever script each
// side is in. Shared by the recipient field and the AI's composeMail name resolution.
const CYR2LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'ye', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
}

export function translitLatin(s) {
  let out = ''
  for (const ch of String(s || '').toLowerCase()) out += ch in CYR2LAT ? CYR2LAT[ch] : ch
  return out
}

// lowercase latin word-tokens for cross-script substring matching. The y→i collapse folds
// the common romanization split (Irina/Iryna, Andrey/Andrei, и↔y) so a Russian-spelled name
// still matches a Ukrainian-romanized contact.
export const norm = (s) =>
  translitLatin(s)
    .replace(/y/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
