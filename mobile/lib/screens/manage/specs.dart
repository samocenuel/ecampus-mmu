import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/app_state.dart';
import '../../widgets/common.dart';
import 'resource_screen.dart';

String _leader(Map r, String nameKey) => r[nameKey] != null ? '${r[nameKey]}' : 'Not appointed';
String _person(Map u) => '${u['title'] != null ? '${u['title']} ' : ''}${u['name']}';
bool _admin(AppState a) => a.isAdmin;
bool _adminOrDean(AppState a) => a.isAdmin || a.role == 'dean';
bool _managers(AppState a) => a.isManager;

final facultiesSpec = RSpec(
  title: 'Faculties',
  noun: 'Faculty',
  endpoint: '/api/faculties',
  intro: 'Each faculty is led by a Dean who oversees its departments.',
  titleOf: (r) => '${r['name']}',
  subtitleOf: (r) => 'Dean: ${_leader(r, 'dean_name')} · ${r['department_count']} departments',
  canCreate: _admin,
  canEdit: _admin,
  canDelete: _admin,
  deleteMessage: 'Deleting a faculty also deletes its departments, programmes and classes.',
  refs: {'deans': RefSpec('/api/users?role=dean&active=1', _person)},
  fields: const [
    FSpec('name', 'Faculty name', required: true),
    FSpec('code', 'Code'),
    FSpec('dean_id', 'Dean', type: FType.select, ref: 'deans'),
  ],
  fromRow: (r) => {'name': r['name'], 'code': r['code'], 'dean_id': r['dean_id']},
);

final departmentsSpec = RSpec(
  title: 'Departments',
  noun: 'Department',
  endpoint: '/api/departments',
  intro: 'Departments belong to a faculty and are managed by a Head of Department (HoD).',
  titleOf: (r) => '${r['name']}',
  subtitleOf: (r) => '${r['faculty_name']} · HoD: ${_leader(r, 'hod_name')} · ${r['program_count']} programmes',
  canCreate: _adminOrDean,
  canEdit: _adminOrDean,
  canDelete: _adminOrDean,
  deleteMessage: 'Deleting a department also deletes its programmes and classes.',
  refs: {
    'faculties': RefSpec('/api/faculties', (r) => '${r['name']}'),
    'hods': RefSpec('/api/users?role=hod&active=1', _person),
  },
  fields: const [
    FSpec('faculty_id', 'Faculty', type: FType.select, ref: 'faculties', required: true),
    FSpec('name', 'Department name', required: true),
    FSpec('code', 'Code'),
    FSpec('hod_id', 'Head of Department', type: FType.select, ref: 'hods'),
  ],
  fromRow: (r) => {'faculty_id': r['faculty_id'], 'name': r['name'], 'code': r['code'], 'hod_id': r['hod_id']},
);

const _levels = ['Certificate', 'Diploma', 'Bachelor', 'Postgraduate Diploma', 'Masters', 'PhD'];

final programmesSpec = RSpec(
  title: 'Programmes',
  noun: 'Programme',
  endpoint: '/api/programs',
  titleOf: (r) => '${r['code']} · ${r['name']}',
  subtitleOf: (r) => '${r['department_name']} · ${r['level']} · ${r['duration_years']} yrs · ${r['course_unit_count']} units',
  canCreate: _managers,
  canEdit: _managers,
  canDelete: _managers,
  deleteMessage: 'Deleting a programme also deletes its classes.',
  refs: {'departments': RefSpec('/api/departments', (r) => '${r['name']}')},
  fields: [
    const FSpec('department_id', 'Department', type: FType.select, ref: 'departments', required: true),
    const FSpec('name', 'Programme name', required: true),
    const FSpec('code', 'Code', required: true),
    FSpec('level', 'Level', type: FType.select, required: true, options: [for (final l in _levels) (l, l)], defaultValue: 'Bachelor'),
    const FSpec('duration_years', 'Duration (years)', type: FType.number, defaultValue: 3),
  ],
  fromRow: (r) => {'department_id': r['department_id'], 'name': r['name'], 'code': r['code'], 'level': r['level'], 'duration_years': r['duration_years']},
);

final courseUnitsSpec = RSpec(
  title: 'Course units',
  noun: 'Course unit',
  endpoint: '/api/course-units',
  intro: 'Cross-cutting units are shared across programmes and must be created and allocated first.',
  titleOf: (r) => '${r['code']} · ${r['name']}',
  subtitleOf: (r) =>
      '${r['credit_units']} CU · ${r['hours_per_week']} hrs/wk · ${(r['programs'] as List).isEmpty ? 'not linked' : (r['programs'] as List).map((p) => '${p['code']} Y${p['year_of_study']}S${p['semester']}').join(', ')}',
  badgeOf: (r) => r['is_cross_cutting'] == 1 ? 'CROSS-CUTTING' : null,
  canCreate: _managers,
  canEdit: _managers,
  canDelete: _managers,
  refs: {
    'departments': RefSpec('/api/departments', (r) => '${r['name']}'),
    'programs': RefSpec('/api/programs', (r) => '${r['code']}'),
  },
  fields: const [
    FSpec('code', 'Course code', required: true),
    FSpec('name', 'Course unit name', required: true),
    FSpec('is_cross_cutting', 'Cross-cutting unit', type: FType.toggle, help: 'Shared across programmes; allocated before other units', defaultValue: false),
    FSpec('credit_units', 'Credit units', type: FType.number, defaultValue: 3),
    FSpec('hours_per_week', 'Contact hours per week', type: FType.number, defaultValue: 3),
    FSpec('department_id', 'Owning department', type: FType.select, ref: 'departments'),
    FSpec('preferred_room_type', 'Room needed', type: FType.select, options: [('lecture', 'Lecture hall'), ('lab', 'Laboratory'), ('seminar', 'Seminar room')]),
    FSpec('description', 'Description', type: FType.multiline),
    FSpec('program_ids', 'Programmes', type: FType.multiselect, ref: 'programs', help: 'Programme-specific units belong to one programme only', showIf: _creatingOnly),
    FSpec('year_of_study', 'Year of study', type: FType.number, defaultValue: 1, showIf: _creatingOnly),
    FSpec('semester', 'Semester', type: FType.number, defaultValue: 1, showIf: _creatingOnly),
  ],
  fromRow: (r) => {
    'code': r['code'],
    'name': r['name'],
    'is_cross_cutting': r['is_cross_cutting'] == 1,
    'credit_units': r['credit_units'],
    'hours_per_week': r['hours_per_week'],
    'department_id': r['department_id'],
    'preferred_room_type': r['preferred_room_type'],
    'description': r['description'],
    '_editing': true,
  },
  toPayload: (f, creating) {
    final body = <String, dynamic>{
      for (final k in ['code', 'name', 'is_cross_cutting', 'credit_units', 'hours_per_week', 'description']) k: f[k],
      'department_id': (f['department_id'] == '' ? null : f['department_id']),
      'preferred_room_type': (f['preferred_room_type'] == '' ? null : f['preferred_room_type']),
    };
    if (creating) {
      body['programs'] = [
        for (final p in (f['program_ids'] as List? ?? [])) {'program_id': p, 'year_of_study': f['year_of_study'] ?? 1, 'semester': f['semester'] ?? 1},
      ];
    }
    return body;
  },
);

bool _creatingOnly(Map<String, dynamic> form) => form['_editing'] != true;

final roomsSpec = RSpec(
  title: 'Rooms',
  noun: 'Room',
  endpoint: '/api/rooms',
  titleOf: (r) => '${r['name']}',
  subtitleOf: (r) => '${r['building'] ?? '-'} · ${r['capacity']} seats · ${r['room_type']}${r['active'] == 1 ? '' : ' · unavailable'}',
  canCreate: _admin,
  canEdit: _admin,
  canDelete: _admin,
  deleteMessage: 'Deleting a room also removes every timetable session booked in it.',
  fields: const [
    FSpec('name', 'Room name', required: true),
    FSpec('building', 'Building'),
    FSpec('capacity', 'Seats', type: FType.number, required: true, defaultValue: 60),
    FSpec('room_type', 'Type', type: FType.select, required: true, options: [('lecture', 'Lecture hall'), ('lab', 'Laboratory'), ('seminar', 'Seminar room')], defaultValue: 'lecture'),
    FSpec('active', 'Available for timetabling', type: FType.toggle, defaultValue: true),
  ],
  fromRow: (r) => {...r, 'active': r['active'] == 1},
);

final termsSpec = RSpec(
  title: 'Academic terms',
  noun: 'Term',
  endpoint: '/api/terms',
  titleOf: (r) => '${r['name']}${r['is_current'] == 1 ? ' (current)' : ''}',
  subtitleOf: (r) => 'Semester ${r['semester']} · ${r['start_date'] ?? '?'} to ${r['end_date'] ?? '?'}',
  canCreate: _admin,
  canEdit: _admin,
  canDelete: _admin,
  deleteMessage: 'Deleting a term deletes its allocations, timetable and attendance.',
  fields: const [
    FSpec('name', 'Name', required: true),
    FSpec('academic_year', 'Academic year'),
    FSpec('semester', 'Semester', type: FType.number, required: true, defaultValue: 1),
    FSpec('start_date', 'Start date', type: FType.date),
    FSpec('end_date', 'End date', type: FType.date),
    FSpec('is_current', 'Current term', type: FType.toggle),
  ],
  fromRow: (r) => {...r, 'is_current': r['is_current'] == 1},
);

RSpec classesSpec(BuildContext context) => RSpec(
      title: 'Classes',
      noun: 'Class',
      endpoint: '/api/classes',
      intro: 'Tap the crown to appoint a class representative, who takes attendance during lectures.',
      titleOf: (r) => '${r['name']}',
      subtitleOf: (r) => '${r['program_code']} · Year ${r['year_of_study']} · ${r['student_count']} students · Rep: ${r['class_rep_name'] ?? 'not appointed'}',
      canCreate: _managers,
      canEdit: _managers,
      canDelete: _managers,
      refs: {'programs': RefSpec('/api/programs', (r) => '${r['code']} - ${r['name']}')},
      fields: const [
        FSpec('program_id', 'Programme', type: FType.select, ref: 'programs', required: true),
        FSpec('name', 'Class name', required: true),
        FSpec('year_of_study', 'Year of study', type: FType.number, defaultValue: 1),
        FSpec('academic_year', 'Academic year / intake'),
        FSpec('expected_size', 'Expected size', type: FType.number, defaultValue: 50),
      ],
      fromRow: (r) => {'program_id': r['program_id'], 'name': r['name'], 'year_of_study': r['year_of_study'], 'academic_year': r['academic_year'], 'expected_size': r['expected_size']},
      actions: (context, r, reload) => [
        IconButton(
          tooltip: 'Appoint class representative',
          icon: const Icon(Icons.workspace_premium_outlined),
          onPressed: () => _appointRep(context, r, reload),
        ),
      ],
    );

Future<void> _appointRep(BuildContext context, Map cls, Future<void> Function() reload) async {
  final api = context.read<AppState>().api;
  final students = await api.get('/api/classes/${cls['id']}/students') as List;
  if (!context.mounted) return;
  final chosen = await showModalBottomSheet<int>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: SizedBox(
        height: MediaQuery.of(ctx).size.height * 0.7,
        child: Column(children: [
          Padding(padding: const EdgeInsets.all(12), child: Text('Class representative · ${cls['name']}', style: Theme.of(ctx).textTheme.titleMedium)),
          Expanded(
            child: students.isEmpty
                ? const EmptyView(icon: Icons.group_off, title: 'No students in this class yet')
                : ListView(children: [
                    for (final s in students)
                      ListTile(
                        leading: Icon(s['id'] == cls['class_rep_id'] ? Icons.workspace_premium : Icons.person_outline),
                        title: Text(s['name'] as String),
                        subtitle: Text(s['identifier'] as String? ?? ''),
                        onTap: () => Navigator.pop(ctx, s['id'] as int),
                      ),
                  ]),
          ),
        ]),
      ),
    ),
  );
  if (chosen == null || !context.mounted) return;
  try {
    await api.put('/api/classes/${cls['id']}/rep', {'student_id': chosen});
    if (context.mounted) showMessage(context, 'Class representative appointed and notified');
    await reload();
  } catch (e) {
    if (context.mounted) showError(context, e);
  }
}

const _creatable = {
  'admin': ['admin', 'dean', 'hod', 'lecturer', 'student'],
  'dean': ['hod', 'lecturer', 'student'],
  'hod': ['lecturer', 'student'],
};

RSpec usersSpec(AppState app, String group) {
  final roles = {'staff': 'lecturer,hod,dean', 'students': 'student', 'admins': 'admin'}[group]!;
  final allowed = (_creatable[app.role] ?? const []).where((r) => roles.split(',').contains(r)).toList();
  return RSpec(
    title: group == 'students' ? 'Students' : group == 'admins' ? 'Administrators' : 'Lecturers & leaders',
    noun: group == 'students' ? 'Student' : group == 'admins' ? 'Administrator' : 'Staff member',
    endpoint: '/api/users',
    query: '?roles=$roles',
    titleOf: (r) => '${_person(r)}${r['is_class_rep'] == 1 ? '  ★ class rep' : ''}',
    subtitleOf: (r) => '${roleLabels[r['role']]} · ${r['email']} · ${r['class_name'] ?? r['department_name'] ?? r['faculty_name'] ?? '-'}${r['active'] == 1 ? '' : ' · inactive'}',
    canCreate: (_) => allowed.isNotEmpty,
    canEdit: (_) => allowed.isNotEmpty,
    canDelete: (_) => false,
    refs: {
      'faculties': RefSpec('/api/faculties', (r) => '${r['name']}'),
      'departments': RefSpec('/api/departments', (r) => '${r['name']}'),
      'classes': RefSpec('/api/classes', (r) => '${r['name']}'),
    },
    fields: [
      FSpec('role', 'Role', type: FType.select, required: true, options: [for (final r in allowed) (r, roleLabels[r]!)], defaultValue: allowed.isEmpty ? null : allowed.last),
      FSpec('title', 'Title (Dr., Prof., Mr., Ms.)', showIf: (f) => f['role'] != 'student'),
      const FSpec('name', 'Full name', required: true),
      const FSpec('email', 'Email', type: FType.email, required: true),
      const FSpec('phone', 'Phone'),
      FSpec('identifier', group == 'students' ? 'Registration number' : 'Staff number'),
      FSpec('faculty_id', 'Faculty', type: FType.select, ref: 'faculties', showIf: (f) => f['role'] == 'dean'),
      FSpec('department_id', 'Department', type: FType.select, ref: 'departments', showIf: (f) => f['role'] == 'hod' || f['role'] == 'lecturer'),
      FSpec('class_id', 'Class', type: FType.select, ref: 'classes', required: true, showIf: (f) => f['role'] == 'student'),
      const FSpec('password', 'Password (blank = generate temporary)', type: FType.password),
    ],
    fromRow: (r) => {for (final k in ['role', 'title', 'name', 'email', 'phone', 'identifier', 'faculty_id', 'department_id', 'class_id']) k: r[k]},
    toPayload: (f, creating) {
      final body = Map<String, dynamic>.from(f);
      for (final k in ['faculty_id', 'department_id', 'class_id']) {
        if (body[k] == '') body[k] = null;
      }
      if ((body['password'] ?? '') == '') body.remove('password');
      return body;
    },
    onCreated: (context, result) async {
      final temp = result['temporary_password'];
      if (temp == null) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Temporary password'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("Share this with ${result['name']} securely. It's shown only once."),
            const SizedBox(height: 12),
            SelectableText('$temp', style: const TextStyle(fontSize: 20, fontFamily: 'monospace')),
          ]),
          actions: [
            TextButton(onPressed: () => Clipboard.setData(ClipboardData(text: '$temp')), child: const Text('Copy')),
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done')),
          ],
        ),
      );
    },
  );
}
