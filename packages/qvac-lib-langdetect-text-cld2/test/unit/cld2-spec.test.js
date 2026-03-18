import test from 'brittle'
import { detectOne, detectMultiple, getLangName, getISO2FromName } from '../../index.js'

// ---------------------------------------------------------------------------
// Test: CLD2 – 80+ language coverage (representative sample)
//
// SPEC: "Supports 80+ languages, compared to tinyld's more limited coverage"
// WHY: The pitch's primary selling point is broad language coverage.
//      Must prove detection works beyond English/French.
// ---------------------------------------------------------------------------
test('CLD2: detects languages across major language families', async (t) => {
  const samples = {
    en: 'The quick brown fox jumps over the lazy dog near the riverbank.',
    fr: 'Les enfants jouent dans le jardin pendant que leurs parents préparent le dîner.',
    es: 'Los niños están jugando en el parque mientras sus padres preparan la cena.',
    de: 'Die Kinder spielen im Garten, während ihre Eltern das Abendessen zubereiten.',
    pt: 'As crianças estão brincando no parque enquanto seus pais preparam o jantar.',
    it: 'I bambini giocano nel giardino mentre i genitori preparano la cena.',
    nl: 'De kinderen spelen in de tuin terwijl hun ouders het avondeten bereiden.',
    ru: 'Дети играют в саду, пока их родители готовят ужин на кухне.',
    ar: 'الأطفال يلعبون في الحديقة بينما يقوم الوالدان بإعداد العشاء في المطبخ.',
    hi: 'बच्चे बगीचे में खेल रहे हैं जबकि उनके माता-पिता रसोई में खाना बना रहे हैं।',
    ja: '子供たちは庭で遊んでいて、両親は台所で夕食を作っています。',
    zh: '孩子们在花园里玩耍，而他们的父母在厨房里准备晚餐。',
    ko: '아이들은 정원에서 놀고 있고, 부모님은 부엌에서 저녁을 준비하고 있습니다.',
    tr: 'Çocuklar bahçede oynuyor, ebeveynleri ise mutfakta akşam yemeği hazırlıyor.',
    pl: 'Dzieci bawią się w ogrodzie, podczas gdy rodzice przygotowują kolację w kuchni.',
    sv: 'Barnen leker i trädgården medan föräldrarna lagar middag i köket.',
    fi: 'Lapset leikkivät puutarhassa ja vanhemmat valmistavat illallista keittiössä.',
    vi: 'Bọn trẻ đang chơi trong vườn trong khi bố mẹ chuẩn bị bữa tối trong bếp.',
    th: 'เด็กๆ กำลังเล่นในสวนขณะที่พ่อแม่กำลังเตรียมอาหารเย็นในครัว',
    uk: 'Діти грають у саду, поки батьки готують вечерю на кухні.'
  }

  for (const [expectedCode, text] of Object.entries(samples)) {
    const result = await detectOne(text)
    t.ok(result, `${expectedCode}: returned result`)
    t.is(typeof result.code, 'string', `${expectedCode}: code is string`)
    t.is(typeof result.language, 'string', `${expectedCode}: language is string`)
    t.ok(result.code !== 'und', `${expectedCode}: not Undetermined (got ${result.code}: ${result.language})`)
    t.comment(`${expectedCode} → detected: ${result.code} (${result.language})`)
  }
})

// ---------------------------------------------------------------------------
// Test: CLD2 – CJK script detection (unigrams)
//
// SPEC: "unigrams for CJK scripts"
// WHY: CJK is called out in the pitch as using a different detection method.
//      Must verify Chinese, Japanese, Korean are correctly distinguished.
// ---------------------------------------------------------------------------
test('CLD2: CJK scripts detected and distinguished', async (t) => {
  const chinese = '中华人民共和国是世界上人口最多的国家之一，拥有悠久的历史和文化。'
  const japanese = '日本は東アジアに位置する島国で、独自の文化と伝統を持っています。'
  const korean = '대한민국은 동아시아에 위치한 나라로, 독특한 문화와 전통을 가지고 있습니다.'

  const zhResult = await detectOne(chinese)
  t.is(zhResult.code, 'zh', `Chinese detected (got ${zhResult.code}: ${zhResult.language})`)

  const jaResult = await detectOne(japanese)
  t.is(jaResult.code, 'ja', `Japanese detected (got ${jaResult.code}: ${jaResult.language})`)

  const koResult = await detectOne(korean)
  t.is(koResult.code, 'ko', `Korean detected (got ${koResult.code}: ${koResult.language})`)

  t.ok(zhResult.code !== jaResult.code, 'Chinese and Japanese distinguished')
  t.ok(jaResult.code !== koResult.code, 'Japanese and Korean distinguished')
})

// ---------------------------------------------------------------------------
// Test: CLD2 – detectMultiple returns ranked probabilities
//
// SPEC: "detectMultiple" must return array of { code, language, probability }
// WHY: Real-world text often contains mixed languages. Consumers rely on
//      probability ranking to pick the right language.
// ---------------------------------------------------------------------------
test('CLD2: detectMultiple ranks mixed-language text', async (t) => {
  const mixedText = 'Hello, how are you? Bonjour, comment allez-vous? Hola, ¿cómo estás? Guten Tag, wie geht es Ihnen?'
  const results = await detectMultiple(mixedText, 3)

  t.ok(Array.isArray(results), 'returns array')
  t.ok(results.length > 0, 'at least one result')
  t.ok(results.length <= 3, 'respects topK=3')

  for (const r of results) {
    t.is(typeof r.code, 'string', `code is string: ${r.code}`)
    t.is(typeof r.language, 'string', `language is string: ${r.language}`)
    t.is(typeof r.probability, 'number', `probability is number: ${r.probability}`)
    t.ok(r.probability >= 0 && r.probability <= 1, `probability in [0,1]: ${r.probability}`)
  }

  if (results.length > 1) {
    t.ok(results[0].probability >= results[1].probability, 'results sorted by probability descending')
  }

  t.comment(JSON.stringify(results, null, 2))
})

// ---------------------------------------------------------------------------
// Test: CLD2 – real-world content (long, mixed, numbers, URLs)
//
// SPEC: Testing philosophy — "Long/substantial content", "Mixed content"
// WHY: Short toy inputs hide bugs. Real text has numbers, URLs, punctuation.
// ---------------------------------------------------------------------------
test('CLD2: handles real-world content patterns', async (t) => {
  const longEnglish = 'The United Nations was established on October 24, 1945, with the aim of preventing future wars. It replaced the League of Nations, which had failed to prevent World War II. The organization has grown from 51 member states in 1945 to 193 member states today. Its headquarters is located in New York City, with other main offices in Geneva, Nairobi, and Vienna. The UN operates through six principal organs: the General Assembly, the Security Council, the Economic and Social Council, the Trusteeship Council, the International Court of Justice, and the Secretariat.'
  const longResult = await detectOne(longEnglish)
  t.is(longResult.code, 'en', 'long multi-sentence English detected')

  const withNumbers = 'The population of Tokyo is approximately 13,960,000 as of 2023. The city covers an area of 2,194 km² with a density of 6,363 people per square kilometer.'
  const numResult = await detectOne(withNumbers)
  t.is(numResult.code, 'en', 'text with numbers/statistics detected')

  const withUrls = 'Please visit https://www.example.com/path?query=value for more information. Contact us at support@company.org or call +1-555-0123.'
  const urlResult = await detectOne(withUrls)
  t.ok(urlResult.code !== 'und', 'text with URLs and email not Undetermined')

  const withPunctuation = '¡Hola! ¿Cómo estás hoy? Estoy muy bien, muchas gracias por preguntar. Espero que tengas un excelente día lleno de alegría y buenas noticias.'
  const punctResult = await detectOne(withPunctuation)
  t.is(punctResult.code, 'es', 'text with special punctuation (Spanish) detected')
})

// ---------------------------------------------------------------------------
// Test: CLD2 – short and ambiguous text
//
// SPEC: Testing philosophy — edge cases with minimal input
// WHY: Users often detect language on short strings (search queries, chat
//      messages, single words). CLD2 may return Undetermined for very short
//      text — that's acceptable, but it must not crash.
// ---------------------------------------------------------------------------
test('CLD2: short and ambiguous text does not crash', async (t) => {
  const singleWord = 'Bonjour'
  const wordResult = await detectOne(singleWord)
  t.ok(wordResult, 'single word returns result')
  t.is(typeof wordResult.code, 'string', 'single word code is string')

  const twoChars = 'Hi'
  const twoResult = await detectOne(twoChars)
  t.ok(twoResult, 'two-char input returns result')

  const numbersOnly = '1234567890 42 99.5 100%'
  const numOnlyResult = await detectOne(numbersOnly)
  t.ok(numOnlyResult, 'numbers-only returns result (may be Undetermined)')

  const punctOnly = '!!! ??? ... --- *** @@@ ###'
  const punctOnlyResult = await detectOne(punctOnly)
  t.ok(punctOnlyResult, 'punctuation-only returns result')
  t.comment(`numbers-only: ${numOnlyResult.code}, punct-only: ${punctOnlyResult.code}`)
})

// ---------------------------------------------------------------------------
// Test: CLD2 – async API contract (Risk #1 from pitch)
//
// SPEC: Risk #1 "Functions will need to become async since node-cld lang
//       detect is asynchronous"
// WHY: The pitch calls this out as a breaking change. Consumers must be able
//      to await these functions. Verify they return Promises.
// ---------------------------------------------------------------------------
test('CLD2: detectOne and detectMultiple return Promises', async (t) => {
  const promise1 = detectOne('Hello world testing language detection.')
  t.ok(promise1 instanceof Promise, 'detectOne returns a Promise')

  const promise2 = detectMultiple('Hello world testing language detection.')
  t.ok(promise2 instanceof Promise, 'detectMultiple returns a Promise')

  const result1 = await promise1
  t.ok(result1.code, 'detectOne Promise resolves to result with code')

  const result2 = await promise2
  t.ok(Array.isArray(result2), 'detectMultiple Promise resolves to array')
})

// ---------------------------------------------------------------------------
// Test: CLD2 – API shape matches predecessor contract
//
// SPEC: "The public api for @qvac/langdetect-text-cld2 will remain the
//       exact same as the predecessor @qvac/langdetect-text"
// SPEC: "Maintain API compatibility with existing detectOne, detectMultiple,
//       getLangName, and getISO2FromName functions"
// WHY: Consumers switching from the predecessor must not break. Return shapes
//      must be identical.
// ---------------------------------------------------------------------------
test('CLD2: API shape matches predecessor contract', async (t) => {
  const oneResult = await detectOne('This is a test sentence in English.')
  t.ok('code' in oneResult, 'detectOne has .code')
  t.ok('language' in oneResult, 'detectOne has .language')
  t.is(Object.keys(oneResult).length, 2, 'detectOne returns exactly { code, language }')

  const multiResult = await detectMultiple('This is a test sentence in English.', 1)
  t.ok(Array.isArray(multiResult), 'detectMultiple returns array')
  const first = multiResult[0]
  t.ok('code' in first, 'detectMultiple item has .code')
  t.ok('language' in first, 'detectMultiple item has .language')
  t.ok('probability' in first, 'detectMultiple item has .probability')
  t.is(Object.keys(first).length, 3, 'detectMultiple item returns exactly { code, language, probability }')

  const langName = getLangName('en')
  t.is(typeof langName, 'string', 'getLangName returns string')

  const iso2 = getISO2FromName('English')
  t.is(typeof iso2, 'string', 'getISO2FromName returns string')

  const nullName = getLangName('zzz')
  t.is(nullName, null, 'getLangName returns null for unknown code')

  const nullIso = getISO2FromName('NotALanguage')
  t.is(nullIso, null, 'getISO2FromName returns null for unknown name')
})

// ---------------------------------------------------------------------------
// Test: CLD2 – sequential detection calls on same module
//
// SPEC: Testing philosophy — "Sequential calls on the same instance"
// WHY: Real integrations call detectOne repeatedly in a loop (processing
//      messages, scanning documents). State must not leak between calls.
// ---------------------------------------------------------------------------
test('CLD2: sequential calls produce independent results', async (t) => {
  const inputs = [
    { text: 'The weather is beautiful today and the sun is shining brightly.', expected: 'en' },
    { text: 'Le temps est magnifique aujourd\'hui et le soleil brille de mille feux.', expected: 'fr' },
    { text: 'El clima es hermoso hoy y el sol brilla intensamente en el cielo.', expected: 'es' },
    { text: 'Das Wetter ist heute wunderschön und die Sonne scheint hell am Himmel.', expected: 'de' },
    { text: 'Погода сегодня прекрасная и солнце ярко светит в небе над городом.', expected: 'ru' },
    { text: 'The weather is beautiful today and the sun is shining brightly.', expected: 'en' }
  ]

  for (const { text, expected } of inputs) {
    const result = await detectOne(text)
    t.is(result.code, expected, `sequential: ${expected} detected correctly after prior calls`)
  }
})

// ---------------------------------------------------------------------------
// Test: CLD2 – RTL script detection (Arabic, Hebrew)
//
// SPEC: "Supports 80+ languages" — includes RTL scripts
// WHY: RTL text can trip up text processing pipelines. Must detect correctly.
// ---------------------------------------------------------------------------
test('CLD2: RTL scripts (Arabic, Hebrew) detected correctly', async (t) => {
  const arabic = 'المملكة العربية السعودية هي أكبر دولة في شبه الجزيرة العربية وتضم الحرمين الشريفين.'
  const arResult = await detectOne(arabic)
  t.is(arResult.code, 'ar', `Arabic detected (got ${arResult.code})`)

  const hebrew = 'מדינת ישראל היא מדינה דמוקרטית במזרח התיכון הממוקמת על חוף הים התיכון.'
  const heResult = await detectOne(hebrew)
  t.is(heResult.code, 'he', `Hebrew detected (got ${heResult.code})`)
})

// ---------------------------------------------------------------------------
// Test: CLD2 – Indic scripts
//
// SPEC: "Supports 80+ languages" — includes Indic scripts
// WHY: Hindi, Bengali, etc. use distinct scripts. Must not confuse them.
// ---------------------------------------------------------------------------
test('CLD2: Indic scripts (Hindi, Bengali) detected', async (t) => {
  const hindi = 'भारत एक विशाल देश है जो दक्षिण एशिया में स्थित है और विविध संस्कृतियों का घर है।'
  const hiResult = await detectOne(hindi)
  t.is(hiResult.code, 'hi', `Hindi detected (got ${hiResult.code}: ${hiResult.language})`)

  const bengali = 'বাংলাদেশ দক্ষিণ এশিয়ার একটি দেশ যা সমৃদ্ধ সংস্কৃতি এবং ইতিহাসের জন্য পরিচিত।'
  const bnResult = await detectOne(bengali)
  t.is(bnResult.code, 'bn', `Bengali detected (got ${bnResult.code}: ${bnResult.language})`)
})
