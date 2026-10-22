import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// Scoped reports: Admin = university, Dean = faculty, HoD = department, lecturer = own teaching.
/// Filters and section choices apply to the screen and to the PDF / Excel downloads.
class ReportsScreen extends StatefulWidget {
  const ReportsScreen({super.key});

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

const _filterKeys = ['faculty_id', 'department_id', 'program_id', 'year_of_study', 'class_id', 'course_unit_id', 'lecturer_id', 'from', 'to', 'threshold'];

class _ReportsScreenState extends State<ReportsScreen> {
  Map<String, String> _filters = {};
  List<String>? _sections;
  Map<String, dynamic>? _options;

  String get _query {
    final p = <String, String>{
      for (final e in _filters.entries)
        if (e.value.isNotEmpty) e.key: e.value,
      if (_sections != null) 'sections': _sections!.join(','),
    };
    return Uri(queryParameters: p).query;
  }

  bool _show(String key) => _sections == null || _sections!.contains(key);

  Future<void> _export(String format) async {
    final q = _query;
    try {
      await context.read<AppState>().openExport('/api/reports/export?format=$format${q.isEmpty ? '' : '&$q'}');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _openFilters() async {
    final app = context.read<AppState>();
    try {
      _options ??= await app.api.get('/api/reports/options') as Map<String, dynamic>;
    } catch (e) {
      if (mounted) showError(context, e);
      return;
    }
    if (!mounted) return;
    final result = await showModalBottomSheet<(Map<String, String>, List<String>?)>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _FilterSheet(options: _options!, filters: _filters, sections: _sections, lecturer: app.role == 'lecturer'),
    );
    if (result != null) {
      setState(() {
        _filters = result.$1;
        _sections = result.$2;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    final active = _filters.values.where((v) => v.isNotEmpty).length + (_sections != null ? 1 : 0);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Reports'),
        actions: [
          IconButton(tooltip: 'Filters', icon: Badge(isLabelVisible: active > 0, label: Text('$active'), child: const Icon(Icons.tune)), onPressed: _openFilters),
          IconButton(tooltip: 'Download PDF', icon: const Icon(Icons.picture_as_pdf_outlined), onPressed: () => _export('pdf')),
          IconButton(tooltip: 'Download Excel', icon: const Icon(Icons.table_view_outlined), onPressed: () => _export('xlsx')),
        ],
      ),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey(_query),
        load: () async => await app.api.get('/api/reports/overview?$_query') as Map<String, dynamic>,
        builder: (context, r, reload) {
          final c = r['counts'] as Map<String, dynamic>;
          final att = r['attendance'] as Map<String, dynamic>;
          final labels = ((r['filters'] as Map?)?['labels'] as List? ?? const []).cast<String>();
          final missed = r['missed'] as Map? ?? const {'items': []};
          final scheme = Theme.of(context).colorScheme;
          return ListView(padding: const EdgeInsets.all(12), children: [
            Text('Scope: ${r['scope']}', style: const TextStyle(fontWeight: FontWeight.w600)),
            Text([r['term']?['name'] ?? 'No term', ...labels].join(' · '), style: TextStyle(color: scheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            if (_show('summary'))
              StatGrid(children: [
                if (r['role'] != 'lecturer') StatTile(label: 'Departments', value: '${c['departments']}'),
                if (r['role'] != 'lecturer') StatTile(label: 'Programmes', value: '${c['programs']}'),
                StatTile(label: 'Students', value: '${c['students']}'),
                if (r['role'] != 'lecturer') StatTile(label: 'Lecturers', value: '${c['lecturers']}'),
                StatTile(label: 'Units allocated', value: '${c['course_units_allocated']}'),
                StatTile(label: 'Weekly teaching', value: '${c['weekly_teaching_hours']} h'),
                StatTile(label: 'Avg attendance', value: rateText(att['average_rate'] as num?), color: rateColor(context, att['average_rate'] as num?)),
                StatTile(label: 'Awaiting approval', value: '${att['pending_registers']}'),
              ]),
            const SizedBox(height: 12),
            if (_show('departments') && (r['departments'] as List).length > 1)
              SectionCard(
                title: 'Departments',
                child: Column(children: [
                  for (final d in r['departments'])
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(d['name'] as String),
                      subtitle: Text('${d['programs']} programmes · ${d['students']} students · ${d['lecturers']} lecturers'),
                      trailing: Text(rateText(d['attendance_rate'] as num?), style: TextStyle(fontWeight: FontWeight.w700, color: rateColor(context, d['attendance_rate'] as num?))),
                    ),
                ]),
              ),
            if (_show('workload'))
              SectionCard(
                title: 'Lecturer workload',
                child: Column(children: [
                  if ((r['workload'] as List).isEmpty) const Text('No lecturers match these filters.'),
                  for (final w in r['workload'])
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(w['name'] as String),
                      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${w['department']} · ${w['units']} units'),
                        const SizedBox(height: 4),
                        LinearProgressIndicator(value: ((w['allocated_hours'] as num) / 20).clamp(0, 1).toDouble(), minHeight: 6, borderRadius: BorderRadius.circular(6)),
                      ]),
                      trailing: Text('${w['allocated_hours']} h/wk', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ),
                ]),
              ),
            if (_show('course_attendance'))
              SectionCard(
                title: 'Attendance by course unit',
                child: Column(children: [
                  if ((att['by_course'] as List).isEmpty) const Text('No course units match these filters.'),
                  for (final cu in att['by_course'])
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Row(children: [Flexible(child: Text('${cu['code']} ${cu['name']}', overflow: TextOverflow.ellipsis)), if (cu['is_cross_cutting'] == 1) const CcBadge()]),
                      subtitle: Text('${cu['classes']} · ${cu['registers']} lectures'),
                      trailing: Text(rateText(cu['rate'] as num?), style: TextStyle(fontWeight: FontWeight.w700, color: rateColor(context, cu['rate'] as num?))),
                    ),
                ]),
              ),
            if (_show('class_attendance'))
              SectionCard(
                title: 'Attendance by class',
                child: Column(children: [
                  for (final cl in att['by_class'])
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('${cl['name']}'),
                      subtitle: Text('${cl['students']} students · ${cl['registers']} lectures'),
                      trailing: Text(rateText(cl['rate'] as num?), style: TextStyle(fontWeight: FontWeight.w700, color: rateColor(context, cl['rate'] as num?))),
                    ),
                ]),
              ),
            if (_show('at_risk'))
              SectionCard(
                title: 'Students below ${att['at_risk_threshold']}%',
                child: Column(children: [
                  if ((att['at_risk'] as List).isEmpty) const Text('No students below the threshold.'),
                  for (final s in att['at_risk'])
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(backgroundColor: scheme.errorContainer, child: Icon(Icons.warning_amber, color: scheme.onErrorContainer)),
                      title: Text(s['name'] as String),
                      subtitle: Text('${s['class_name']} · ${s['attended']}/${s['total']}'),
                      trailing: Text(rateText(s['rate'] as num?), style: TextStyle(fontWeight: FontWeight.w700, color: scheme.error)),
                    ),
                ]),
              ),
            if (_show('missed'))
              SectionCard(
                title: 'Lectures with no attendance (${(missed['items'] as List).length})',
                child: Column(children: [
                  if ((missed['items'] as List).isEmpty) const Text('Every lecture had attendance taken.'),
                  for (final o in missed['items'])
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('${o['course_code']} ${o['course_name']}', overflow: TextOverflow.ellipsis),
                      subtitle: Text('${niceDate(o['date'] as String)} ${o['start_time']}-${o['end_time']} · ${o['lecturer_name']}\n${(o['classes'] as List).map((c) => c['name']).join(', ')}'),
                      isThreeLine: true,
                    ),
                ]),
              ),
            if (_show('rooms') && (r['rooms'] as List).isNotEmpty)
              SectionCard(
                title: 'Room utilisation',
                child: Column(children: [
                  for (final room in r['rooms'])
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [Expanded(child: Text('${room['name']} (${room['capacity']})')), Text('${room['utilisation']}%')]),
                        const SizedBox(height: 4),
                        LinearProgressIndicator(value: ((room['utilisation'] as num) / 100).clamp(0, 1).toDouble(), minHeight: 6, borderRadius: BorderRadius.circular(6)),
                      ]),
                    ),
                ]),
              ),
          ]);
        },
      ),
    );
  }
}

/// Bottom sheet: department, programme, year, class, course unit, lecturer, dates, threshold and sections.
class _FilterSheet extends StatefulWidget {
  const _FilterSheet({required this.options, required this.filters, required this.sections, required this.lecturer});
  final Map<String, dynamic> options;
  final Map<String, String> filters;
  final List<String>? sections;
  final bool lecturer;

  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<_FilterSheet> {
  late final Map<String, String> _f = {for (final k in _filterKeys) k: widget.filters[k] ?? ''};
  late final Map<String, String> _allSections = (widget.options['sections'] as Map).map((k, v) => MapEntry('$k', '$v'));
  late final Set<String> _sections = {...(widget.sections ?? _allSections.keys)};

  List<Map> _list(String key) => (widget.options[key] as List? ?? const []).cast<Map>();

  void _set(String key, String value) => setState(() {
        _f[key] = value;
        const clears = {
          'faculty_id': ['department_id', 'program_id', 'class_id', 'course_unit_id', 'lecturer_id'],
          'department_id': ['program_id', 'class_id', 'course_unit_id', 'lecturer_id'],
          'program_id': ['class_id'],
          'year_of_study': ['class_id'],
        };
        for (final c in clears[key] ?? const <String>[]) {
          _f[c] = '';
        }
      });

  Widget _select(String key, String label, String all, List<Map> items, String Function(Map) text) {
    if (items.isEmpty) return const SizedBox.shrink();
    final value = items.any((i) => '${i['id']}' == _f[key]) ? _f[key]! : '';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: DropdownButtonFormField<String>(
        isExpanded: true,
        initialValue: value,
        key: ValueKey('$key-$value-${items.length}'),
        decoration: InputDecoration(labelText: label),
        items: [DropdownMenuItem(value: '', child: Text(all)), for (final i in items) DropdownMenuItem(value: '${i['id']}', child: Text(text(i), overflow: TextOverflow.ellipsis))],
        onChanged: (v) => _set(key, v ?? ''),
      ),
    );
  }

  Future<void> _pickDate(String key) async {
    final now = DateTime.now();
    final d = await showDatePicker(context: context, firstDate: DateTime(now.year - 3), lastDate: DateTime(now.year + 1), initialDate: DateTime.tryParse(_f[key]!) ?? now);
    if (d != null) _set(key, isoDate(d));
  }

  @override
  Widget build(BuildContext context) {
    final fac = _f['faculty_id']!, dep = _f['department_id']!, prog = _f['program_id']!, year = _f['year_of_study']!;
    final departments = _list('departments').where((d) => fac.isEmpty || '${d['faculty_id']}' == fac).toList();
    final deptIds = departments.map((d) => d['id']).toSet();
    bool inDept(Map x) => dep.isNotEmpty ? '${x['department_id']}' == dep : fac.isEmpty || deptIds.contains(x['department_id']);
    final programs = _list('programs').where((p) => widget.lecturer || inDept(p)).toList();
    final programIds = programs.map((p) => p['id']).toSet();
    final classes = _list('classes').where((c) => (prog.isNotEmpty ? '${c['program_id']}' == prog : programIds.contains(c['program_id'])) && (year.isEmpty || '${c['year_of_study']}' == year)).toList();
    final units = _list('course_units').where((u) => widget.lecturer || (fac.isEmpty && dep.isEmpty) || inDept(u)).toList();
    final lecturers = _list('lecturers').where((l) => (fac.isEmpty && dep.isEmpty) || inDept(l)).toList();
    final years = {for (final c in _list('classes')) c['year_of_study'] as int}.toList()..sort();
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, MediaQuery.of(context).viewInsets.bottom + 12),
        child: SingleChildScrollView(
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Choose what you need', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            if (_list('faculties').length > 1) _select('faculty_id', 'Faculty', 'All faculties', _list('faculties'), (f) => '${f['name']}'),
            if (departments.length > 1) _select('department_id', 'Department', 'All departments', departments, (d) => '${d['name']}'),
            _select('program_id', 'Programme', 'All programmes', programs, (p) => '${p['code']} · ${p['name']}'),
            if (years.length > 1) _select('year_of_study', 'Year of study', 'All years', [for (final y in years) {'id': y}], (y) => 'Year ${y['id']}'),
            _select('class_id', 'Class', 'All classes', classes, (c) => '${c['name']}'),
            _select('course_unit_id', 'Course unit', 'All course units', units, (u) => '${u['code']} · ${u['name']}'),
            _select('lecturer_id', 'Lecturer', 'All lecturers', lecturers, (l) => [l['title'], l['name']].whereType<String>().join(' ')),
            Row(children: [
              Expanded(child: OutlinedButton.icon(onPressed: () => _pickDate('from'), icon: const Icon(Icons.event), label: Text(_f['from']!.isEmpty ? 'From' : _f['from']!))),
              const SizedBox(width: 8),
              Expanded(child: OutlinedButton.icon(onPressed: () => _pickDate('to'), icon: const Icon(Icons.event), label: Text(_f['to']!.isEmpty ? 'To' : _f['to']!))),
            ]),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: ['60', '70', '75', '80', '90'].contains(_f['threshold']) ? _f['threshold'] : '75',
              decoration: const InputDecoration(labelText: 'Students at risk below'),
              items: [for (final t in ['60', '70', '75', '80', '90']) DropdownMenuItem(value: t, child: Text('$t%'))],
              onChanged: (v) => _set('threshold', v == '75' ? '' : v ?? ''),
            ),
            const SizedBox(height: 12),
            Text('Sections', style: Theme.of(context).textTheme.labelLarge),
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final e in _allSections.entries)
                if (!widget.lecturer || !['departments', 'rooms', 'allocation'].contains(e.key))
                  FilterChip(
                    label: Text(e.value),
                    selected: _sections.contains(e.key),
                    onSelected: (v) => setState(() => v ? _sections.add(e.key) : _sections.remove(e.key)),
                  ),
            ]),
            const SizedBox(height: 16),
            Row(children: [
              TextButton(
                onPressed: () => Navigator.pop(context, (<String, String>{}, null)),
                child: const Text('Clear'),
              ),
              const Spacer(),
              FilledButton(
                onPressed: () {
                  final all = _sections.length == _allSections.length;
                  Navigator.pop(context, (Map<String, String>.from(_f)..removeWhere((k, v) => v.isEmpty), all ? null : _allSections.keys.where(_sections.contains).toList()));
                },
                child: const Text('Apply'),
              ),
            ]),
          ]),
        ),
      ),
    );
  }
}
