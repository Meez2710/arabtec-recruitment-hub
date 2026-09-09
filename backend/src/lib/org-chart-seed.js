// Phase 1 organization chart: table bootstrap + seed-if-empty reconstruction.
// Source: Project Org Charts.zip (2026-09-08) plus ATS loadset project/department
// catalogue. Head Office chart was not in the zip — HO is reconstructed as
// departments and shared/area staff only. Do not wipe existing rows.
import { get, exec } from './db.js';
import { OrganizationNodes } from './organization-nodes.js';

export function ensureOrganizationChartSchema() {
  exec(`
    CREATE TABLE IF NOT EXISTS organization_node (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT,
      position_title TEXT NOT NULL DEFAULT '',
      department TEXT,
      project_or_location TEXT,
      parent_id INTEGER REFERENCES organization_node(id) ON DELETE RESTRICT,
      node_type TEXT NOT NULL DEFAULT 'employee_position',
      status TEXT NOT NULL DEFAULT 'filled',
      sort_order INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER REFERENCES users(id),
      department_id INTEGER REFERENCES department(id),
      project_id INTEGER REFERENCES project(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orgnode_parent ON organization_node(parent_id);
    CREATE INDEX IF NOT EXISTS idx_orgnode_type ON organization_node(node_type);
    CREATE INDEX IF NOT EXISTS idx_orgnode_project ON organization_node(project_or_location);
  `);
}

function unit(title, extra = {}) {
  return {
    employeeName: '',
    positionTitle: title,
    nodeType: extra.nodeType || 'organizational_unit',
    status: 'filled',
    ...extra,
  };
}
function person(name, title, extra = {}) {
  return {
    employeeName: name,
    positionTitle: title,
    nodeType: name ? 'employee_position' : 'vacant_position',
    status: name ? 'filled' : 'vacant',
    ...extra,
  };
}
function vacant(title, extra = {}) {
  return person('', title, { nodeType: 'vacant_position', status: 'vacant', ...extra });
}

function insertTree(node, parentId, sortOrder) {
  const { children, ...fields } = node;
  const created = OrganizationNodes.create({
    ...fields,
    parentId: parentId == null ? null : parentId,
    sortOrder: sortOrder ?? 0,
  });
  (children || []).forEach((child, i) => insertTree(child, created.id, i));
  return created;
}

function loc(project, department) {
  return { department: department || '', projectOrLocation: project || '' };
}

function projectTeam(project, department, people) {
  return people.map((p) => ({
    ...p,
    ...loc(project, p.department || department),
  }));
}

export function seedOrganizationChartIfEmpty() {
  // Bundled reference records are development fixtures, never production updates.
  if (process.env.NODE_ENV === 'production') return { seeded: false, reason: 'production' };
  ensureOrganizationChartSchema();
  if ((get('SELECT COUNT(*) AS c FROM organization_node')?.c || 0) > 0) return { seeded: false };

  const tree = unit('Arabtec Egypt', {
    nodeType: 'organizational_unit',
    department: 'Head Office',
    projectOrLocation: 'Head Office',
    notes: 'Company root. No CEO was named in the supplied charts; later Head Office updates can be applied here.',
    children: [
      unit('Head Office', {
        nodeType: 'organizational_unit',
        department: 'Head Office',
        projectOrLocation: 'Head Office',
        notes: 'Head Office org chart was not in the 8 Sep 2026 zip. Departments and shared/area staff only.',
        children: [
          person('Saeed Hosny', 'HR Manager', {
            ...loc('Head Office', 'Human Resources'),
            notes: 'Unclear in source whether this role is HR or IT; placed under HR pending Head Office chart.',
            children: [],
          }),
          person('Antonuos Atef', 'HSE Manager', {
            ...loc('Head Office / Area', 'HSE'),
            notes: 'Shared/area HSE. Appears across project charts; placed once under Head Office.',
          }),
          person('Mohamed El Refai', 'QA/QC Manager', {
            ...loc('Head Office / Area', 'QA/QC'),
            notes: 'Shared/area QA/QC (also spelled Refaie). Placed once under Head Office.',
          }),
          person('Mohamed Samir', 'Technical Manager', {
            ...loc('Head Office / Area', 'Technical Office'),
            notes: 'Shared/area technical staff. Placed once under Head Office.',
          }),
          person('Amr Ali', 'Area Manager', {
            ...loc('Head Office / Area', 'Construction'),
            notes: 'Shared/area construction support. Placed once under Head Office.',
          }),
          person('Mahmoud Yousri', 'Area Commercial / Cost', {
            ...loc('Head Office / Area', 'Commercial'),
            notes: 'Shared/area (also spelled Yousry). Placed once under Head Office.',
          }),
          person('Mohamed El Baz', 'Area MEP', {
            ...loc('Head Office / Area', 'MEP'),
            notes: 'Shared/area MEP (also spelled Elbaz). Placed once under Head Office.',
          }),
          vacant('Head of Design', { ...loc('Head Office', 'Design'), notes: 'Loadset vacant department head (DEP-DESIGN).' }),
          vacant('Head of Plant & Equipment', { ...loc('Head Office', 'Plant & Equipment'), notes: 'Loadset vacant department head (DEP-PLANT).' }),
          vacant('Head of IT', { ...loc('Head Office', 'IT'), notes: 'Loadset vacant department head (DEP-IT).' }),
          vacant('Head of Business Development', { ...loc('Head Office', 'Business Development'), notes: 'Loadset vacant department head (DEP-BD).' }),
          vacant('Head of Legal', { ...loc('Head Office', 'Legal'), notes: 'Loadset vacant department head (DEP-LEGAL).' }),
        ],
      }),
      unit('Projects', {
        nodeType: 'organizational_unit',
        department: 'Projects',
        projectOrLocation: 'Projects',
        children: [
          unit('Aliva', {
            nodeType: 'project',
            ...loc('Aliva', 'Projects'),
            notes: 'Source: Aliva PDF. Loadset PM Ahmed Abo Zaid ≈ PDF Ahmed Abuzeid.',
            children: projectTeam('Aliva', 'Projects', [
              person('Ahmed Abuzeid', 'Project Manager', {
                children: [
                  person('Mohamed Baraka', 'Deputy Project Manager', loc('Aliva', 'Projects')),
                  person('Aly Wageh', 'Planning Manager', loc('Aliva', 'Planning')),
                  person('Mahmoud Mohamed', 'Deputy Technical Manager', loc('Aliva', 'Technical Office')),
                  person('Moataz Abdelqawy', 'Construction Manager', loc('Aliva', 'Construction')),
                  person('Moataz Abdelaziz', 'Construction Manager', loc('Aliva', 'Construction')),
                  person('Mohamed Salah', 'Construction Manager', loc('Aliva', 'Construction')),
                  person('Mohamed Salama', 'Planning Engineer', loc('Aliva', 'Planning')),
                  person('Ahmed El Shafie', 'Project Engineer', loc('Aliva', 'Construction')),
                  person('Mohamed Medhat', 'Project Engineer', loc('Aliva', 'Construction')),
                  person('Mohamed Desoky', 'Project Engineer', loc('Aliva', 'Construction')),
                  person('Ahmed Wahid', 'Project Engineer', loc('Aliva', 'Construction')),
                  person('Ahmed Mahmoud', 'Project Engineer', loc('Aliva', 'Construction')),
                  person('Mohamed Kamal', 'Section Engineer', loc('Aliva', 'Construction')),
                  person('Islam Youssef', 'Section Engineer', loc('Aliva', 'Construction')),
                  person('Mostafa Adel', 'Section Engineer', loc('Aliva', 'Construction')),
                  person('Amir Reda', 'Section Engineer', loc('Aliva', 'Construction')),
                  person('Mohamed Mostafa', 'Section Engineer', loc('Aliva', 'Construction')),
                  person('Nader Osama', 'Structural Engineer', loc('Aliva', 'Technical Office')),
                  person('Amr Mohsen', 'Structural Engineer', loc('Aliva', 'Technical Office')),
                  person('Mohamed Helmy', 'Electrical Engineer', loc('Aliva', 'MEP')),
                  person('Ahmed Ashraf', 'Mechanical Engineer', loc('Aliva', 'MEP')),
                  person('Essam Kareem', 'Sr Electrical Engineer', loc('Aliva', 'MEP')),
                  person('Hazem Ahmed', 'Sr Mechanical Engineer', loc('Aliva', 'MEP')),
                  person('Ahmed Abdelrahman', 'Chief Land Surveyor', loc('Aliva', 'Survey')),
                  person('Abdulrahman Mamdouh', 'Document Controller', loc('Aliva', 'Document Control')),
                  person('Yassien Yousry', 'Document Controller', loc('Aliva', 'Document Control')),
                  person('Ahmed Mohamed', 'Document Controller', {
                    ...loc('Aliva', 'Document Control'),
                    notes: 'Chart date mark 26/8.',
                  }),
                  person('Ali Mohamed', 'Assistant Document Controller', loc('Aliva', 'Document Control')),
                  person('Tamer Elsayed', 'First Aider', loc('Aliva', 'HSE')),
                  person('Ahmed Hussien Salah Ahmed', 'QA/QC Engineer', {
                    ...loc('Aliva', 'QA/QC'),
                    notes: 'Full legal name from Aliva QA/QC chart page 2.',
                  }),
                  person('Fikry Khaled Fikry Mahmoud AbdulMagid', 'QA/QC Engineer', loc('Aliva', 'QA/QC')),
                  person('Ahmed Mohamed Mahmoud Khalil', 'QA/QC Engineer', loc('Aliva', 'QA/QC')),
                  person('Farouk Assem Agamy Mohamed Darwiesh', 'QA/QC Engineer', loc('Aliva', 'QA/QC')),
                  person('Basil Nizar Mohamed Ibrahim', 'QA/QC Engineer', loc('Aliva', 'QA/QC')),
                  person('Ahmed Samir Ahmed Beshady', 'QA/QC Engineer', loc('Aliva', 'QA/QC')),
                  person('Abdelrahman Mohamed Abdelmoneam Mohamed Mostafa', 'Junior QA/QC Engineer', loc('Aliva', 'QA/QC')),
                  vacant('Commercial Manager', loc('Aliva', 'Commercial')),
                  vacant('Procurement Engineer', loc('Aliva', 'Procurement')),
                ],
              }),
            ]),
          }),
          unit('Al-Burouj', {
            nodeType: 'project',
            ...loc('Al-Burouj', 'Projects'),
            notes: 'PDF PM Mohamed Hassan. Loadset listed Mohamed Taha. PDF used as current source.',
            children: projectTeam('Al-Burouj', 'Projects', [
              person('Mohamed Hassan', 'Project Manager', {
                notes: 'Also PM of Mountain View 1 Extension. Conflict: loadset named Mohamed Taha for Al-Burouj.',
                children: [
                  vacant('Deputy Project Manager', loc('Al-Burouj', 'Projects')),
                  vacant('Construction Manager', loc('Al-Burouj', 'Construction')),
                  vacant('Planning Engineer', loc('Al-Burouj', 'Planning')),
                ],
              }),
            ]),
          }),
          unit('Mountain View 1 Extension', {
            nodeType: 'project',
            ...loc('Mountain View 1 Extension', 'Projects'),
            children: projectTeam('Mountain View 1 Extension', 'Projects', [
              person('Mohamed Hassan', 'Project Manager', {
                children: [
                  person('Amr Attia', 'Deputy Project Manager', loc('Mountain View 1 Extension', 'Projects')),
                  person('Ahmed Fathi', 'Sr Electrical / Mechanical Engineer', loc('Mountain View 1 Extension', 'MEP')),
                  person('Mohamed Anwar', 'Document Controller', loc('Mountain View 1 Extension', 'Document Control')),
                  person('Mostafa Hamdy', 'Sr Document Controller', loc('Mountain View 1 Extension', 'Document Control')),
                  person('Paula Walid', 'Junior Structural Engineer', loc('Mountain View 1 Extension', 'Technical Office')),
                  person('Samia Wasfy', 'Junior Structural Engineer', loc('Mountain View 1 Extension', 'Technical Office')),
                  person('Ahmed Hamdy', 'Site / Section Engineer', loc('Mountain View 1 Extension', 'Construction')),
                  person('Mahmoud Omar', 'Site / Section Engineer', loc('Mountain View 1 Extension', 'Construction')),
                  person('Elsayed Saber', 'Site / Section Engineer', loc('Mountain View 1 Extension', 'Construction')),
                  person('Mohamed Hanafy', 'Chief Land Surveyor', loc('Mountain View 1 Extension', 'Survey')),
                  person('Ali Badr Ali', 'Surveyor', loc('Mountain View 1 Extension', 'Survey')),
                  person('Mohamed Ramdan', 'Surveyor', loc('Mountain View 1 Extension', 'Survey')),
                  person('Ishaq Gergis', 'Foreman', loc('Mountain View 1 Extension', 'Construction')),
                ],
              }),
            ]),
          }),
          unit('Caesar', {
            nodeType: 'project',
            ...loc('Caesar', 'Projects'),
            notes: 'PDF PM Mohamed Sabbah (loadset Mohamed Sabah).',
            children: projectTeam('Caesar', 'Projects', [
              person('Mohamed Sabbah', 'Project Manager', {
                children: [
                  vacant('Deputy Project Manager', loc('Caesar', 'Projects')),
                  vacant('Construction Manager', loc('Caesar', 'Construction')),
                ],
              }),
            ]),
          }),
          unit('Hills of One', {
            nodeType: 'project',
            ...loc('Hills of One', 'Projects'),
            children: projectTeam('Hills of One', 'Projects', [
              person('Rafaat Mofreh', 'Project Manager', {
                children: [
                  vacant('Deputy Project Manager', loc('Hills of One', 'Projects')),
                ],
              }),
            ]),
          }),
          unit('June Parcel 07', {
            nodeType: 'project',
            ...loc('June Parcel 07', 'Projects'),
            children: projectTeam('June Parcel 07', 'Projects', [
              person('Mohamed Mohsen', 'Project Manager', {
                notes: 'Also PM of Solare.',
                children: [
                  vacant('Deputy Project Manager', loc('June Parcel 07', 'Projects')),
                ],
              }),
            ]),
          }),
          unit('Solare', {
            nodeType: 'project',
            ...loc('Solare', 'Projects'),
            children: projectTeam('Solare', 'Projects', [
              person('Mohamed Mohsen', 'Project Manager', {
                children: [vacant('Deputy Project Manager', loc('Solare', 'Projects'))],
              }),
            ]),
          }),
          unit('LVLS', {
            nodeType: 'project',
            ...loc('LVLS', 'Projects'),
            notes: 'PDF PM Wael El Henawy. Loadset listed Emad Waheed. PDF used as current source.',
            children: projectTeam('LVLS', 'Projects', [
              person('Wael El Henawy', 'Project Manager', {
                children: [
                  vacant('Deputy Project Manager', loc('LVLS', 'Projects')),
                  vacant('Construction Manager', loc('LVLS', 'Construction')),
                ],
              }),
            ]),
          }),
          unit('Lagoon iCity', {
            nodeType: 'project',
            ...loc('Lagoon iCity', 'Projects'),
            notes: 'PDF PM Ramy Rabie (loadset Ramy Rabiea). Same person also PM of Lagoon Villas and Mountain Park.',
            children: projectTeam('Lagoon iCity', 'Projects', [
              person('Ramy Rabie', 'Project Manager', {
                children: [vacant('Deputy Project Manager', loc('Lagoon iCity', 'Projects'))],
              }),
            ]),
          }),
          unit('Lagoon Villas', {
            nodeType: 'project',
            ...loc('Lagoon Villas', 'Projects'),
            children: projectTeam('Lagoon Villas', 'Projects', [
              person('Ramy Rabie', 'Project Manager', {
                children: [
                  person('Mohamed Samy', 'Deputy Project Manager', loc('Lagoon Villas', 'Projects')),
                ],
              }),
            ]),
          }),
          unit('Mountain Park', {
            nodeType: 'project',
            ...loc('Mountain Park', 'Projects'),
            children: projectTeam('Mountain Park', 'Projects', [
              person('Ramy Rabie', 'Project Manager', {
                children: [
                  person('Mohamed Samy', 'Deputy Project Manager', loc('Mountain Park', 'Projects')),
                  person('Ahmed Adel', 'Construction Manager', loc('Mountain Park', 'Construction')),
                ],
              }),
            ]),
          }),
          unit('Seazen', {
            nodeType: 'project',
            ...loc('Seazen', 'Projects'),
            children: projectTeam('Seazen', 'Projects', [
              person('Ahmed Khaled', 'Project Manager', {
                children: [vacant('Deputy Project Manager', loc('Seazen', 'Projects'))],
              }),
            ]),
          }),
          unit('Soul', {
            nodeType: 'project',
            ...loc('Soul', 'Projects'),
            notes: 'No project PDF in the 8 Sep 2026 zip. Structure only; PM not invented.',
            children: [vacant('Project Manager', loc('Soul', 'Projects'))],
          }),
          unit('Water Bodies', {
            nodeType: 'project',
            ...loc('Water Bodies', 'Projects'),
            notes: 'No project PDF in the 8 Sep 2026 zip. Structure only; PM not invented.',
            children: [vacant('Project Manager', loc('Water Bodies', 'Projects'))],
          }),
          unit('The Estate', {
            nodeType: 'project',
            ...loc('The Estate', 'Projects'),
            notes: 'Loadset has no PM. No project PDF in the zip.',
            children: [vacant('Project Manager', loc('The Estate', 'Projects'))],
          }),
          unit('Mountain Park Landscape', {
            nodeType: 'project',
            ...loc('Mountain Park Landscape', 'Projects'),
            notes: 'No project PDF in the 8 Sep 2026 zip. Structure only; PM not invented.',
            children: [vacant('Project Manager', loc('Mountain Park Landscape', 'Projects'))],
          }),
        ],
      }),
    ],
  });

  insertTree(tree, null, 0);
  return { seeded: true, count: OrganizationNodes.count() };
}
