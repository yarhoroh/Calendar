// Russian homographs: same spelling, stress (and meaning) differ. A word-by-word
// dictionary can't tell them apart — it returns ONE reading — so "на горе" came out
// "го́ре" (grief) instead of "горе́" (on the hill). Here we pick by CONTEXT: the
// default (more frequent) reading, overridden to the alternative when a trigger word
// or a preposition sits nearby.
//
// This is a curated list of the FREQUENT problem cases, not every homograph in the
// language — the long tail keeps the dictionary default (no worse than today). Zero
// extra memory: plain data + a substring check, no model.
//
// Entry: def = default stressed form, alt = alternative stressed form, near = lowercase
// STEMS matched as substrings in a small window (so "склон" catches склоне/склонах),
// prev = words that, immediately before, force the alt. Stress = combining acute U+0301
// right AFTER the stressed vowel.

export const HOMOGRAPHS = {
  // го́ре (grief) / горе́ (on the hill — prepositional of гора)
  'горе':  { def: 'го́ре',  alt: 'горе́',  prev: ['на'],       near: ['склон', 'вершин', 'высок', 'крут', 'подъём', 'холм', 'скал', 'возвыш', 'пик'] },
  // за́мок (castle) / замо́к (lock)
  'замок': { def: 'за́мок', alt: 'замо́к', near: ['ключ', 'двер', 'закр', 'откр', 'висяч', 'кодов', 'цеп', 'ворот', 'повес', 'замкну', 'защёлк', 'сейф', 'амбар'] },
  'замка': { def: 'за́мка', alt: 'замка́', near: ['ключ', 'двер', 'закр', 'откр', 'висяч', 'цеп', 'сейф'] },
  'замки': { def: 'за́мки', alt: 'замки́', near: ['ключ', 'двер', 'закр', 'висяч', 'цеп', 'дужк'] },
  // мука́ (flour) / му́ка (torment)
  'мука':  { def: 'мука́',  alt: 'му́ка',  near: ['мучен', 'страдан', 'терзан', 'адск', 'невыносим', 'душевн', 'сплошн', 'сущ'] },
  'муку':  { def: 'муку́',  alt: 'му́ку',  near: ['мучен', 'страдан', 'терзан', 'адск', 'невыносим', 'душевн'] },
  'муки':  { def: 'муки́',  alt: 'му́ки',  near: ['мучен', 'страдан', 'терзан', 'адск', 'душевн', 'творч', 'совест'] },
  // до́рого/дорого́й handled elsewhere; доро́га (road) / дорога́ (dear, short adj)
  'дорога':{ def: 'доро́га',alt: 'дорога́',near: ['сердц', 'памя', 'жизн', 'мне', 'очень', 'слишком', 'цен'] },
  // духи́ (perfume) / ду́хи (spirits)
  'духи':  { def: 'духи́',  alt: 'ду́хи',  near: ['зл', 'лес', 'предк', 'вызыв', 'вод', 'тёмн', 'нечист', 'бесплотн'] },
  // белки́ (proteins/whites) / бе́лки (squirrels)
  'белки': { def: 'бе́лки', alt: 'белки́', near: ['яиц', 'протеин', 'грамм', 'жир', 'углевод', 'глаз', 'молок', 'питан', 'раздел'] },
  // по́лки (shelves) / полки́ (regiments)
  'полки': { def: 'по́лки', alt: 'полки́', near: ['солдат', 'арми', 'воен', 'бой', 'команд', 'гвард', 'пехот', 'наступ'] },
  // кру́жки (mugs) / кружки́ (small circles / clubs)
  'кружки':{ def: 'кру́жки',alt: 'кружки́',near: ['рисова', 'начерт', 'секц', 'танцева', 'геометр', 'обвед', 'нарисова'] },
  // о́рган (body organ) / орга́н (musical organ) — + common oblique forms (music sense)
  'орган':  { def: 'о́рган',  alt: 'орга́н',  near: ['музык', 'играл', 'церкв', 'звуч', 'концерт', 'клавиш', 'труб', 'бах'] },
  'органа': { def: 'о́ргана', alt: 'орга́на', near: ['музык', 'играл', 'церкв', 'звуч', 'концерт', 'клавиш', 'труб'] },
  'органе': { def: 'о́ргане', alt: 'орга́не', near: ['музык', 'играл', 'церкв', 'звуч', 'концерт', 'клавиш', 'труб', 'сыгр'] },
  'органом':{ def: 'о́рганом',alt: 'орга́ном',near: ['музык', 'играл', 'церкв', 'звуч', 'концерт', 'клавиш', 'труб'] },
  // а́тлас (atlas) / атла́с (satin)
  'атлас': { def: 'а́тлас', alt: 'атла́с', near: ['тка', 'плат', 'блест', 'шёлк', 'наряд', 'гладк', 'бант'] },
  // хло́пок (cotton) / хлопо́к (clap)
  'хлопок':{ def: 'хло́пок',alt: 'хлопо́к',near: ['ладон', 'раздал', 'звук', 'выстрел', 'громк', 'дверь', 'резк', 'аплод'] },
  // вести́ (to lead — verb) / ве́сти (news)
  'вести': { def: 'вести́', alt: 'ве́сти', near: ['нов', 'послед', 'хорош', 'плох', 'приход', 'дошл', 'сообщ', 'радост', 'дурн', 'разнос'] },
  // плачу́ (I pay) / пла́чу (I cry)
  'плачу': { def: 'плачу́', alt: 'пла́чу', near: ['слёз', 'рыда', 'навзрыд', 'горьк', 'от радост', 'реву', 'всхлип'] },
  // уже́ (already) / у́же (narrower)
  'уже':   { def: 'уже́',   alt: 'у́же',   near: ['узк', 'шире', 'тесн', 'проход', 'тали', 'ручейк', 'намног'] },
  // пото́м (later) / по́том (with sweat)
  'потом': { def: 'пото́м', alt: 'по́том', near: ['пот', 'лоб', 'облив', 'холодн', 'испарин', 'покры', 'умыл'] },
  // целу́ю (I kiss) / це́лую (whole, fem acc)
  'целую': { def: 'целу́ю', alt: 'це́лую', near: ['недел', 'месяц', 'год', 'час', 'жизн', 'ноч', 'страну', 'вечност', 'тарелк', 'дорог'] },
  // про́пасть (abyss) / пропа́сть (to vanish)
  'пропасть': { def: 'про́пасть', alt: 'пропа́сть', near: ['исчез', 'сгин', 'безвест', 'могл', 'может', 'бесслед', 'даром', 'зря'] },
  // пари́ть (to soar) / па́рить (to steam)
  'парить':{ def: 'пари́ть', alt: 'па́рить', near: ['бан', 'овощ', 'котл', 'веник', 'кож', 'молок'] },
  // вина́ (guilt) / ви́на (of wine)
  'вина':  { def: 'вина́',  alt: 'ви́на',  near: ['бокал', 'бутыл', 'красн', 'бел', 'пить', 'выпи', 'сорт', 'бутылк', 'налив'] },
  // сто́ит (costs / is worth / ought) / стои́т (is standing)
  'стоит': { def: 'сто́ит', alt: 'стои́т', near: ['там', 'здесь', 'угл', 'стен', 'ме́сте', 'дом', 'двор', 'пол', 'непод', 'ждёт', 'молч'] },
  // сто́ят (they cost / are worth) / стоя́т (they are standing)
  'стоят': { def: 'сто́ят', alt: 'стоя́т', near: ['там', 'здесь', 'угл', 'стен', 'ме́сте', 'ряд', 'очеред', 'двор', 'пол', 'непод', 'ждут', 'молч', 'навытяжк', 'поле'] },
  // сте́ны (walls, plural) / стены́ (of the wall — genitive singular, "у стены́")
  'стены': { def: 'сте́ны', alt: 'стены́', prev: ['у', 'около', 'возле', 'от', 'до', 'вдоль', 'подле', 'мимо', 'напротив', 'вблизи', 'касаясь'] },
  // ---- frequent semantic homographs from the silero list (variants theirs, triggers ours) ----
  // до́ма (at home, adverb) / дома́ (houses)
  'дома':  { def: 'до́ма',  alt: 'дома́',  near: ['высок', 'многоэтаж', 'кирпич', 'новостро', 'этаж', 'квартал', 'панельн', 'постро', 'сноси', 'жил'] },
  // трусы́ (underwear) / тру́сы (cowards)
  'трусы': { def: 'трусы́', alt: 'тру́сы', near: ['трус', 'бо́язл', 'сбежа', 'испуга', 'предат', 'жалк', 'позорн'] },
  // пи́ли (drank) / пили́ (were sawing / saw!)
  'пили':  { def: 'пи́ли',  alt: 'пили́',  near: ['дров', 'доск', 'бревн', 'ножовк', 'пил', 'брус', 'ветк', 'ствол'] },
  // мою́ (my, fem acc) / мо́ю (I wash)
  'мою':   { def: 'мою́',   alt: 'мо́ю',   near: ['рук', 'посу́д', 'пол', 'окн', 'голов', 'тарелк', 'мыл', 'вымы', 'машин'] },
  // па́ры (couples) / пары́ (of steam, gen)
  'пары':  { def: 'па́ры',  alt: 'пары́',  near: ['вод', 'горяч', 'ко́тл', 'испар', 'бензин', 'ядовит', 'спирт'] },
  // бе́рег (shore) / берёг (guarded — past of беречь)
  'берег': { def: 'бе́рег', alt: 'берёг', near: ['храни', 'защища', 'бере́чь', 'деньг', 'сил', 'здоров', 'копи', 'он '] },
  // за́пах (smell) / запа́х (wrapped himself — past of запахнуть)
  'запах': { def: 'за́пах', alt: 'запа́х', near: ['пальто', 'халат', 'полы', 'плотн', 'куртк', 'шуб'] },
  // рожки́ (pasta / little horns) / ро́жки (little horns, dim)
  'рожки': { def: 'ро́жки', alt: 'рожки́', near: ['макарон', 'варил', 'паст', 'сыр', 'тарелк', 'вермишел', 'гарнир'] },
  // ко́сит (mows / squints) — usually one reading; skip ambiguous verbs for now
}

// Choose the reading for a homograph at position `idx` in `words` (all lowercase).
export function pickHomograph(entry, words, idx) {
  const prevWord = idx > 0 ? words[idx - 1] : ''
  if (entry.prev && entry.prev.includes(prevWord)) return entry.alt
  if (entry.near) {
    for (let j = Math.max(0, idx - 3); j <= Math.min(words.length - 1, idx + 3); j++) {
      if (j === idx) continue
      const w = words[j]
      if (entry.near.some((stem) => w.includes(stem))) return entry.alt
    }
  }
  return entry.def
}
