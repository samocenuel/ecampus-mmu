import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

String _rooms(Map e) => (e['rooms'] as List).map((r) => r['name']).join(', ');

/// Exam timetable. Students see whether they qualify to sit; staff see invigilation duties.
class ExamsScreen extends StatelessWidget {
  const ExamsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final tabs = <(String, Widget)>[
      if (app.isStudent) ('My exams', const _MyExams()),
      if (!app.isStudent) ('My duties', const _MyExams()),
      if (!app.isStudent) ('Timetable', const _Timetable()),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Exams'),
          actions: [
            IconButton(
              tooltip: 'Exam timetable PDF',
              icon: const Icon(Icons.picture_as_pdf_outlined),
              onPressed: () async {
                try {
                  await app.openExport('/api/exams/export?format=pdf');
                } catch (e) {
                  if (context.mounted) showError(context, e);
                }
              },
            ),
          ],
          bottom: tabs.length > 1 ? TabBar(tabs: [for (final t in tabs) Tab(text: t.$1)]) : null,
        ),
        body: TabBarView(children: [for (final t in tabs) t.$2]),
      ),
    );
  }
}

class _MyExams extends StatelessWidget {
  const _MyExams();

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    return AsyncView<Map<String, dynamic>>(
      load: () async => await app.api.get('/api/exams/mine') as Map<String, dynamic>,
      builder: (context, data, reload) {
        final exams = (data['exams'] as List).cast<Map<String, dynamic>>();
        final t = data['thresholds'] as Map<String, dynamic>? ?? {};
        if (exams.isEmpty) {
          return ListView(children: [
            const SizedBox(height: 60),
            EmptyView(icon: Icons.event_note_outlined, title: app.isStudent ? 'No exams published yet' : 'No invigilation duties'),
          ]);
        }
        return ListView(padding: const EdgeInsets.all(12), children: [
          if (app.isStudent)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                'To sit an exam you need at least ${t['exam_min_attendance'] ?? 75}% attendance and ${t['coursework_min_percent'] ?? 50}% of the coursework marks in that course unit. Your HoD or Dean can clear you if there is a good reason.',
                style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
            ),
          for (final e in exams) _ExamCard(exam: e),
        ]);
      },
    );
  }
}

class _ExamCard extends StatelessWidget {
  const _ExamCard({required this.exam, this.onTap});
  final Map<String, dynamic> exam;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final e = exam;
    final scheme = Theme.of(context).colorScheme;
    final elig = e['eligibility'] as Map<String, dynamic>?;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('${e['course_code']} ${e['course_name']}', style: const TextStyle(fontWeight: FontWeight.w700))),
              if (e['duty'] == true) const Chip(label: Text('Invigilating'), visualDensity: VisualDensity.compact),
            ]),
            const SizedBox(height: 4),
            Text('${niceDate(e['exam_date'])} · ${e['start_time']}-${e['end_time']}'),
            Text(
              [if (e['duty_room'] != null) 'Your room: ${e['duty_room']}' else _rooms(e), '${e['students']} students'].join(' · '),
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
            ),
            if (e['duty'] != true && (e['invigilators'] as List).isNotEmpty)
              Text('Invigilators: ${(e['invigilators'] as List).map((i) => i['name']).join(', ')}', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13)),
            if (elig != null) ...[
              const Divider(height: 20),
              Row(children: [
                Icon(elig['eligible'] == true ? Icons.verified_outlined : Icons.block, color: elig['eligible'] == true ? Colors.green.shade700 : scheme.error),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    elig['eligible'] == true ? (elig['override'] != null ? 'Cleared to sit by ${elig['override']['by'] ?? 'your HoD'}' : 'You qualify to sit this exam') : 'You do not qualify yet',
                    style: TextStyle(fontWeight: FontWeight.w600, color: elig['eligible'] == true ? Colors.green.shade800 : scheme.error),
                  ),
                ),
              ]),
              const SizedBox(height: 6),
              Wrap(spacing: 16, runSpacing: 4, children: [
                Text('Attendance: ${elig['attendance']?['recorded'] == true ? rateText(elig['attendance']['rate'] as num?) : 'not recorded'}'),
                Text('Coursework: ${elig['coursework'] != null ? '${elig['coursework']['mark']}/${elig['coursework']['max']}' : 'no mark yet'}'),
              ]),
              if (elig['eligible'] != true)
                for (final r in (elig['reasons'] as List)) Text('• $r', style: TextStyle(color: scheme.error, fontSize: 13)),
            ],
          ]),
        ),
      ),
    );
  }
}

class _Timetable extends StatelessWidget {
  const _Timetable();

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    return AsyncView<Map<String, dynamic>>(
      load: () async => await app.api.get('/api/exams') as Map<String, dynamic>,
      builder: (context, data, reload) {
        final exams = (data['exams'] as List).cast<Map<String, dynamic>>();
        if (exams.isEmpty) return ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.event_note_outlined, title: 'No exam timetable yet', message: 'The administrator generates it from the web app.')]);
        return ListView(padding: const EdgeInsets.all(12), children: [
          Text('${data['term']?['name'] ?? ''} · tap an exam to see who qualifies', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          const SizedBox(height: 8),
          for (final e in exams)
            _ExamCard(exam: e, onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => EligibilityScreen(examId: e['id'] as int)))),
        ]);
      },
    );
  }
}

/// Who may sit an exam, with the HoD / Dean override.
class EligibilityScreen extends StatefulWidget {
  const EligibilityScreen({super.key, required this.examId});
  final int examId;

  @override
  State<EligibilityScreen> createState() => _EligibilityScreenState();
}

class _EligibilityScreenState extends State<EligibilityScreen> {
  int _version = 0;
  bool _onlyBlocked = true;

  Future<void> _override(Map s) async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Clear ${s['name']} to sit?'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final r in (s['reasons'] as List)) Text('• $r'),
          const SizedBox(height: 12),
          TextField(controller: reason, decoration: const InputDecoration(labelText: 'Reason (e.g. medical leave, with evidence)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Clear to sit')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/exams/${widget.examId}/overrides', {'student_id': s['id'], 'reason': reason.text.trim()});
      if (!mounted) return;
      showMessage(context, '${s['name']} can sit the exam');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _removeOverride(Map s) async {
    final ok = await confirmDialog(context, title: 'Remove the override?', message: '${s['name']} goes back to the normal rules.', confirmLabel: 'Remove', danger: true);
    if (!ok || !mounted) return;
    try {
      await context.read<AppState>().api.delete('/api/exams/${widget.examId}/overrides/${s['id']}');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Who can sit')),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey(_version),
        load: () async => await api.get('/api/exams/${widget.examId}/eligibility') as Map<String, dynamic>,
        builder: (context, data, reload) {
          final exam = data['exam'] as Map<String, dynamic>;
          final all = (data['students'] as List).cast<Map<String, dynamic>>();
          final blocked = all.where((s) => s['eligible'] != true).length;
          final list = _onlyBlocked ? all.where((s) => s['eligible'] != true || s['override'] != null).toList() : all;
          return ListView(padding: const EdgeInsets.all(12), children: [
            SectionCard(
              title: '${exam['course_code']} ${exam['course_name']}',
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${niceDate(exam['exam_date'])} · ${exam['start_time']}-${exam['end_time']} · ${_rooms(exam)}'),
                const SizedBox(height: 10),
                StatGrid(children: [
                  StatTile(label: 'Qualify', value: '${all.length - blocked}', color: Colors.green.shade700),
                  StatTile(label: 'Do not qualify', value: '$blocked', color: blocked > 0 ? scheme.error : null),
                ]),
              ]),
            ),
            SwitchListTile(value: _onlyBlocked, onChanged: (v) => setState(() => _onlyBlocked = v), title: const Text('Only students who need attention'), contentPadding: EdgeInsets.zero),
            if (list.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Text('Everyone qualifies.', textAlign: TextAlign.center)),
            for (final s in list)
              Card(
                margin: const EdgeInsets.only(bottom: 6),
                child: ListTile(
                  leading: Icon(s['eligible'] == true ? Icons.check_circle : Icons.block, color: s['eligible'] == true ? Colors.green.shade600 : scheme.error),
                  title: Text(s['name'] as String),
                  subtitle: Text([
                    '${s['identifier'] ?? ''} · ${s['class_name'] ?? ''}',
                    'Attendance ${s['attendance']['recorded'] == true ? rateText(s['attendance']['rate'] as num?) : '-'} · Coursework ${s['coursework'] != null ? '${s['coursework']['mark']}/${s['coursework']['max']}' : '-'}',
                    if (s['override'] != null) 'Cleared by ${s['override']['by'] ?? '-'}: ${s['override']['reason']}',
                  ].join('\n')),
                  isThreeLine: true,
                  trailing: s['can_override'] == true
                      ? (s['override'] != null
                          ? IconButton(tooltip: 'Remove override', icon: const Icon(Icons.undo), onPressed: () => _removeOverride(s))
                          : s['eligible'] != true
                              ? TextButton(onPressed: () => _override(s), child: const Text('Clear'))
                              : null)
                      : null,
                ),
              ),
          ]);
        },
      ),
    );
  }
}
