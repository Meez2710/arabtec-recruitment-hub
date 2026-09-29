// Automated intake is for candidates in Egypt.
//
// Product-owner rule (29 Sep 2026): a CV the AUTOMATED path reads (the
// careers mailbox, on arrival or from the waiting backlog) from someone located
// outside Egypt does not enter the Talent Pool on its own. A recruiter who
// uploads a CV by hand has made that choice themselves, so the rule does not
// apply there.
//
// Where someone is comes from what the CV says, in this order:
//   1. the stated location — a foreign place, and no Egyptian one, is outside;
//   2. with no usable location, the phone numbers — only foreign country codes
//      (none Egyptian) is outside.
// Anything else is NOT excluded. An unknown is not "outside", and sending
// every silent CV to a person would spend exactly the recruiter time the
// automated path exists to save. Nationality is deliberately ignored: the rule
// is about where the candidate is, not their passport.

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC');

// Egypt, its governorates, and the places Arabtec's projects and candidates
// actually name. Arabic forms included; CVs mix both.
const EGYPT = [
  'egypt', 'arab republic of egypt', 'a.r.e', 'مصر', 'جمهورية مصر',
  'cairo', 'new cairo', 'القاهرة', 'giza', 'الجيزة', 'alexandria', 'alex', 'الإسكندرية', 'الاسكندرية',
  'nasr city', 'مدينة نصر', 'heliopolis', 'مصر الجديدة', 'maadi', 'المعادي', 'mokattam', 'المقطم',
  'zamalek', 'dokki', 'mohandessin', 'shubra', 'شبرا', 'helwan', 'حلوان',
  '6th of october', '6 october', 'october city', 'السادس من أكتوبر', 'sheikh zayed', 'الشيخ زايد',
  'new administrative capital', 'administrative capital', 'new capital', 'العاصمة الإدارية',
  'obour', 'العبور', 'shorouk', 'الشروق', 'badr city', 'al rehab', 'madinaty', 'مدينتي', '10th of ramadan', 'العاشر من رمضان',
  'qalyubia', 'القليوبية', 'banha', 'بنها', 'sharqia', 'الشرقية', 'zagazig', 'الزقازيق', 'dakahlia', 'الدقهلية',
  'mansoura', 'المنصورة', 'gharbia', 'الغربية', 'tanta', 'طنطا', 'menoufia', 'monufia', 'المنوفية', 'shebin',
  'beheira', 'البحيرة', 'damanhour', 'دمنهور', 'kafr el sheikh', 'kafr el-sheikh', 'كفر الشيخ', 'damietta', 'دمياط',
  'port said', 'بورسعيد', 'بور سعيد', 'ismailia', 'الإسماعيلية', 'الاسماعيلية', 'suez', 'السويس', 'ain sokhna', 'sokhna', 'السخنة',
  'fayoum', 'faiyum', 'الفيوم', 'beni suef', 'بني سويف', 'minya', 'المنيا', 'assiut', 'asyut', 'أسيوط', 'اسيوط',
  'sohag', 'سوهاج', 'qena', 'قنا', 'luxor', 'الأقصر', 'aswan', 'أسوان', 'hurghada', 'الغردقة', 'sharm el sheikh', 'sharm', 'شرم الشيخ',
  'marsa alam', 'matrouh', 'مطروح', 'el alamein', 'alamein', 'العلمين', 'north coast', 'الساحل الشمالي', 'sinai', 'سيناء',
  'el arish', 'العريش', 'new valley', 'الوادي الجديد', 'red sea governorate',
];

// Countries and cities CVs sent to Arabtec Egypt name as a current location.
const FOREIGN = [
  'saudi', 'ksa', 'k.s.a', 'kingdom of saudi arabia', 'السعودية', 'riyadh', 'الرياض', 'jeddah', 'jiddah', 'جدة',
  'dammam', 'الدمام', 'khobar', 'الخبر', 'jubail', 'الجبيل', 'makkah', 'mecca', 'مكة', 'madinah', 'medina', 'المدينة المنورة',
  'tabuk', 'تبوك', 'abha', 'neom', 'yanbu', 'ينبع', 'qassim', 'القصيم', 'taif', 'الطائف',
  'uae', 'u.a.e', 'united arab emirates', 'emirates', 'الإمارات', 'الامارات', 'dubai', 'دبي', 'abu dhabi', 'أبوظبي', 'ابوظبي',
  'sharjah', 'الشارقة', 'ajman', 'عجمان', 'ras al khaimah', 'fujairah', 'al ain',
  'qatar', 'قطر', 'doha', 'الدوحة', 'kuwait', 'الكويت', 'bahrain', 'البحرين', 'manama', 'oman', 'عمان', 'muscat', 'مسقط',
  'jordan', 'الأردن', 'الاردن', 'amman', 'lebanon', 'لبنان', 'beirut', 'بيروت', 'iraq', 'العراق', 'baghdad', 'بغداد', 'erbil', 'أربيل', 'basra',
  'syria', 'سوريا', 'damascus', 'دمشق', 'palestine', 'فلسطين', 'yemen', 'اليمن', 'libya', 'ليبيا', 'benghazi', 'tripoli',
  'sudan', 'السودان', 'khartoum', 'الخرطوم', 'morocco', 'المغرب', 'tunisia', 'تونس', 'algeria', 'الجزائر',
  'turkey', 'türkiye', 'تركيا', 'istanbul', 'united kingdom', 'england', 'london', 'united states', 'usa', 'u.s.a', 'canada',
  'germany', 'france', 'italy', 'spain', 'netherlands', 'australia', 'new zealand', 'ireland',
  'india', 'pakistan', 'bangladesh', 'philippines', 'malaysia', 'singapore', 'china', 'nigeria', 'kenya', 'ethiopia',
];

// Whole-word match for Latin terms (so "alex" is not "alexander", "egypt" is
// not "egyptian"); substring match for Arabic, which has no word case.
const hasArabic = (t) => /[؀-ۿ]/.test(t);
function mentions(text, terms) {
  return terms.find((t) => {
    if (hasArabic(t)) return text.includes(t);
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${esc}($|[^a-z])`, 'i').test(text);
  }) ?? null;
}

// Country calling code of one phone number, or null when it has none.
// Egyptian mobiles written locally (01x xxxx xxxx) count as Egyptian.
function phoneCountry(raw) {
  const s = String(raw).replace(/[\s\-().]/g, '');
  if (/^(\+|00)20\d{8,10}$/.test(s) || /^201[0125]\d{8}$/.test(s) || /^01[0125]\d{8}$/.test(s)) return 'EG';
  if (/^(\+|00)(?!20)\d{7,15}$/.test(s)) return 'FOREIGN';
  return null;
}

/**
 * Where the CV says the candidate is.
 * @param {Map<string, unknown>} values  accepted/proposed field values
 * @returns {{ outside: boolean, basis: 'location'|'phone'|null, detail: string|null }}
 */
export function egyptVerdict(values) {
  const location = norm(values.get('location'));
  if (location.trim()) {
    const egypt = mentions(location, EGYPT);
    const foreign = mentions(location, FOREIGN);
    // Both named ("Cairo, Egypt — currently in Riyadh"): not clearly outside.
    if (foreign && !egypt) return { outside: true, basis: 'location', detail: String(values.get('location')) };
    if (egypt) return { outside: false, basis: 'location', detail: String(values.get('location')) };
  }
  const phones = String(values.get('phone') ?? '').split(/[\/,;|]| or /i).map((p) => p.trim()).filter(Boolean);
  const countries = phones.map(phoneCountry).filter(Boolean);
  if (countries.length > 0 && !countries.includes('EG')) {
    return { outside: true, basis: 'phone', detail: phones.join(' / ') };
  }
  return { outside: false, basis: countries.length ? 'phone' : null, detail: null };
}
