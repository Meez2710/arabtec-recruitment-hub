// Domain dictionaries for construction / engineering recruitment.
// Data only — no logic. Kept separate so terms can be extended without touching
// extraction code.

// --- Job title vocabulary ------------------------------------------------------
// The trailing (?=[\s,)\-/]|$) consumes an optional abbreviating period so
// "Sr." becomes "Senior" rather than "Senior.". A plain \b would leave it behind.
const ABBREV_END = '(?=[\\s,)\\-/]|$)';
const ab = (word, full) => [new RegExp(`\\b${word}\\.?${ABBREV_END}`, 'i'), full];
export const SENIORITY = [
  ab('sr', 'Senior'), ab('jr', 'Junior'),
  ab('snr', 'Senior'), ab('jnr', 'Junior'),
  ab('assoc', 'Associate'), ab('asst', 'Assistant'),
  ab('dep', 'Deputy'), ab('mgr', 'Manager'),
  ab('dir', 'Director'), ab('supv', 'Supervisor'),
  ab('coord', 'Coordinator'), ab('spec', 'Specialist'),
  ab('eng', 'Engineer'), ab('tech', 'Technician'),
  ab('admin', 'Administrator'), ab('exec', 'Executive'),
];

// Core nouns that make a line a plausible job title in this sector.
export const TITLE_KEYWORDS = [
  'engineer', 'manager', 'supervisor', 'coordinator', 'director', 'officer',
  'technician', 'foreman', 'superintendent', 'inspector', 'surveyor', 'architect',
  'planner', 'estimator', 'quantity surveyor', 'draftsman', 'drafter', 'designer',
  'consultant', 'specialist', 'administrator', 'analyst', 'controller', 'lead',
  'head', 'chief', 'executive', 'assistant', 'clerk', 'accountant', 'buyer',
  'recruiter', 'generalist', 'partner', 'advisor', 'representative', 'operator',
];

// Sector disciplines — used to boost confidence on ambiguous title lines.
export const DISCIPLINES = [
  'civil', 'structural', 'mechanical', 'electrical', 'architectural', 'hvac',
  'plumbing', 'geotechnical', 'environmental', 'planning', 'scheduling', 'cost',
  'contracts', 'procurement', 'safety', 'hse', 'qa/qc', 'quality', 'site',
  'project', 'construction', 'design', 'technical office', 'mep', 'piping',
  'commissioning', 'document control', 'bim', 'surveying', 'facade', 'finishing',
  'infrastructure', 'roads', 'bridges', 'tunnelling', 'marine', 'utilities',
];

// --- Degrees -------------------------------------------------------------------
export const DEGREE_MAP = [
  [/\b(b\.?\s?sc\.?|bachelor(?:'?s)?(?:\s+degree)?(?:\s+of\s+science)?|b\.?\s?eng\.?|b\.?\s?a\.?|b\.?\s?tech\.?)\b/i, "Bachelor's Degree"],
  [/\b(m\.?\s?sc\.?|master(?:'?s)?(?:\s+degree)?(?:\s+of\s+science)?|m\.?\s?eng\.?|m\.?\s?a\.?|m\.?\s?tech\.?|mba)\b/i, "Master's Degree"],
  [/\b(ph\.?\s?d\.?|doctorate|doctoral)\b/i, 'Doctorate'],
  [/\b(diploma|higher\s+diploma|hnd)\b/i, 'Diploma'],
  [/\b(associate(?:'?s)?\s+degree)\b/i, "Associate's Degree"],
  [/\b(technical\s+(?:school|institute)|vocational)\b/i, 'Technical Certificate'],
];

// Field of study, captured separately from the degree level.
export const MAJOR_KEYWORDS = [
  'civil engineering', 'structural engineering', 'mechanical engineering',
  'electrical engineering', 'architectural engineering', 'architecture',
  'construction management', 'construction engineering', 'industrial engineering',
  'chemical engineering', 'petroleum engineering', 'computer engineering',
  'computer science', 'business administration', 'human resources', 'accounting',
  'finance', 'commerce', 'law', 'economics', 'surveying', 'geology',
  'environmental engineering', 'mechatronics', 'telecommunications',
  'engineering', 'management', 'psychology', 'education',
];

// --- Education institutions ----------------------------------------------------
export const UNIVERSITY_TOKENS = [
  'university', 'universite', 'univ.', 'college', 'institute', 'institut',
  'academy', 'polytechnic', 'faculty', 'school of engineering', 'ecole',
];

// --- Locations (MENA / GCC focus) ----------------------------------------------
export const CITIES = [
  'Cairo', 'Giza', 'Alexandria', 'New Cairo', 'Nasr City', 'Maadi', 'Heliopolis',
  '6th of October', 'Sheikh Zayed', 'New Capital', 'Mansoura', 'Tanta', 'Zagazig',
  'Port Said', 'Suez', 'Ismailia', 'Aswan', 'Luxor', 'Hurghada', 'Sharm El Sheikh',
  'Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Al Ain', 'Ras Al Khaimah', 'Fujairah',
  'Riyadh', 'Jeddah', 'Dammam', 'Khobar', 'Mecca', 'Medina', 'NEOM', 'Jubail', 'Yanbu',
  'Doha', 'Kuwait City', 'Manama', 'Muscat', 'Amman', 'Beirut', 'Baghdad', 'Erbil',
  'Casablanca', 'Rabat', 'Tunis', 'Algiers', 'Tripoli', 'Khartoum', 'Istanbul', 'London',
];
export const COUNTRIES = [
  'Egypt', 'UAE', 'United Arab Emirates', 'Saudi Arabia', 'KSA', 'Qatar', 'Kuwait',
  'Bahrain', 'Oman', 'Jordan', 'Lebanon', 'Iraq', 'Libya', 'Sudan', 'Morocco',
  'Tunisia', 'Algeria', 'Turkey', 'United Kingdom', 'UK', 'Germany', 'Canada',
];

// --- Company suffixes ----------------------------------------------------------
export const COMPANY_SUFFIXES = [
  'llc', 'l.l.c', 'ltd', 'limited', 'inc', 'incorporated', 'co', 'company',
  'corp', 'corporation', 'group', 'holding', 'holdings', 'contracting',
  'construction', 'consultants', 'consulting', 'engineering', 'services',
  'international', 'industries', 'enterprises', 'partners', 'associates', 'gmbh', 'sae', 's.a.e',
];

// Words that disqualify a line from being a company or title.
export const NOISE_WORDS = [
  'responsibilities', 'duties', 'achievements', 'key', 'reference', 'available',
  'present', 'current', 'page', 'curriculum', 'vitae', 'resume',
];

// --- Multilingual section headings --------------------------------------------
// One generic pipeline: every language contributes terms to the SAME canonical
// section names. No language-specific parser branches exist anywhere.
// Arabic is matched without diacritics (see stripArabicDiacritics in the detector).
export const HEADING_TERMS = {
  experience: [
    // English
    'experience', 'work experience', 'professional experience', 'employment',
    'employment history', 'work history', 'career history', 'career summary',
    'professional background', 'work background', 'positions held',
    // Arabic
    'الخبرات', 'الخبرة', 'الخبرات العملية', 'الخبره العمليه', 'الخبرات المهنية',
    'التاريخ الوظيفي', 'السيرة المهنية', 'الوظائف', 'العمل', 'خبرات العمل',
    // German
    'berufserfahrung', 'berufliche erfahrung', 'beruflicher werdegang',
    'praxiserfahrung', 'arbeitserfahrung', 'werdegang',
    // French
    'experience professionnelle', 'experiences professionnelles', 'experience',
    'parcours professionnel', 'carriere', 'emplois',
  ],
  education: [
    'education', 'academic background', 'academic qualifications', 'qualifications',
    'educational background', 'academic history', 'degrees', 'academic',
    'المؤهلات', 'المؤهلات العلمية', 'التعليم', 'الدراسة', 'المؤهل الدراسي',
    'التعليم والمؤهلات', 'الشهادات العلمية', 'الدراسات',
    'ausbildung', 'bildung', 'akademischer werdegang', 'studium', 'schulbildung',
    'formation', 'formations', 'etudes', 'diplomes', 'parcours academique',
  ],
  skills: [
    'skills', 'technical skills', 'core competencies', 'expertise', 'proficiencies',
    'key skills', 'competencies', 'strengths',
    'المهارات', 'المهارات الفنية', 'المهارات التقنية', 'القدرات', 'الكفاءات',
    'kenntnisse', 'faehigkeiten', 'fahigkeiten', 'kompetenzen', 'qualifikationen',
    'competences', 'competence', 'aptitudes', 'savoir faire',
  ],
  summary: [
    'summary', 'professional summary', 'profile', 'objective', 'career objective',
    'overview', 'about', 'about me', 'personal statement', 'introduction',
    'الملخص', 'نبذة', 'نبذة شخصية', 'الهدف الوظيفي', 'الملف الشخصي', 'مقدمة',
    'profil', 'zusammenfassung', 'kurzprofil', 'ueber mich', 'uber mich',
    'resume', 'profil professionnel', 'objectif', 'a propos',
  ],
  certifications: [
    'certifications', 'certificates', 'licenses', 'licences', 'training', 'courses',
    'professional development', 'memberships', 'affiliations',
    'الشهادات', 'الدورات', 'الدورات التدريبية', 'التدريب', 'العضويات', 'التراخيص',
    'zertifikate', 'zertifizierungen', 'weiterbildung', 'schulungen', 'lizenzen',
    'certifications', 'formations complementaires', 'stages',
  ],
  projects: [
    'projects', 'key projects', 'project experience', 'selected projects',
    'project portfolio', 'portfolio',
    'المشاريع', 'المشروعات', 'أهم المشاريع', 'اهم المشاريع',
    'projekte', 'projekterfahrung', 'ausgewaehlte projekte',
    'projets', 'projets realises',
  ],
  languages: [
    'languages', 'language skills', 'linguistic skills',
    'اللغات', 'المهارات اللغوية',
    'sprachen', 'sprachkenntnisse',
    'langues', 'competences linguistiques',
  ],
  contact: [
    'contact', 'contact details', 'contact information', 'contact info',
    'personal details', 'personal information', 'personal data',
    'معلومات الاتصال', 'بيانات الاتصال', 'البيانات الشخصية', 'المعلومات الشخصية',
    'kontakt', 'kontaktdaten', 'persoenliche daten', 'personliche daten',
    'coordonnees', 'informations personnelles', 'donnees personnelles',
  ],
  references: [
    'references', 'referees',
    'المراجع', 'التزكيات',
    'referenzen', 'referenz',
    'references', 'referents',
  ],
};

// Headline / tagline patterns that must NEVER be treated as a company (F1).
// These describe a PERSON, not an employer.
export const HEADLINE_PATTERNS = [
  /\bfresh\s+grad(uate)?\b/i,
  /\bseeking\b|\blooking\s+for\b|\bavailable\s+(?:for|immediately)\b/i,
  /\bcv\b|\bcurriculum\s+vitae\b|\bresume\b/i,
  /\b(?:years?|yrs?)\s+of\s+experience\b/i,
  /\bcandidate\b|\bapplicant\b|\bjob\s+seeker\b/i,
  /\b(?:student|undergraduate|postgraduate|trainee|intern)\b/i,
  /^\s*(?:mr|mrs|ms|dr|eng|engineer)\.?\s/i,
];
