import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'checkin_screen.dart';
import 'home_shell.dart';

class AttendanceScreen extends StatelessWidget {
  const AttendanceScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final tabs = <(String, Widget)>[
      if (app.isClassRep) ('Take attendance', const _SessionsForDate(role: 'rep')),
      if (app.teaches) ('My lectures', const _SessionsForDate(role: 'lecturer')),
      if (app.teaches || app.isManager) ('Approvals', const _RegisterList(status: 'submitted')),
      if (app.teaches || app.isManager) ('Corrections', const _Corrections()),
      if (app.isManager || app.teaches || app.isClassRep) ('Registers', const _RegisterList()),
      if (app.isStudent) ('My attendance', const _MyAttendance()),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          title: const BrandTitle('Attendance'),
          bottom: tabs.length > 1 ? TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final t in tabs) Tab(text: t.$1)]) : null,
        ),
        body: tabs.isEmpty
            ? const EmptyView(icon: Icons.fact_check_outlined, title: 'Nothing here for your role')
            : TabBarView(children: [for (final t in tabs) t.$2]),
      ),
    );
  }
}

/// Lectures on a chosen day: the class rep takes registers, the lecturer sees their status.
class _SessionsForDate extends StatefulWidget {
  const _SessionsForDate({required this.role});
  final String role;

  @override
  State<_SessionsForDate> createState() => _SessionsForDateState();
}

class _SessionsForDateState extends State<_SessionsForDate> {
  DateTime _date = DateTime.now();
  int _version = 0;

  Future<void> _openCheckin(int id) async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CheckinHostScreen(id: id)));
    if (mounted) setState(() => _version++);
  }

  Future<void> _startCheckin(Map i) async {
    try {
      final r = await context.read<AppState>().api.post('/api/checkin/start', {'session_id': i['session']['id'], 'date': isoDate(_date)}) as Map<String, dynamic>;
      if (mounted) await _openCheckin(r['id'] as int);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
        child: Row(children: [
          IconButton(onPressed: () => setState(() => _date = _date.subtract(const Duration(days: 1))), icon: const Icon(Icons.chevron_left)),
          Expanded(
            child: OutlinedButton.icon(
              icon: const Icon(Icons.event),
              label: Text(niceDate(isoDate(_date))),
              onPressed: () async {
                final d = await showDatePicker(context: context, initialDate: _date, firstDate: DateTime.now().subtract(const Duration(days: 30)), lastDate: DateTime.now());
                if (d != null) setState(() => _date = d);
              },
            ),
          ),
          IconButton(
            onPressed: isoDate(_date) == isoDate(DateTime.now()) ? null : () => setState(() => _date = _date.add(const Duration(days: 1))),
            icon: const Icon(Icons.chevron_right),
          ),
        ]),
      ),
      Expanded(
        child: AsyncView<Map<String, dynamic>>(
          key: ValueKey('${widget.role}-${isoDate(_date)}-$_version'),
          load: () async => await api.get('/api/attendance/sessions?date=${isoDate(_date)}') as Map<String, dynamic>,
          builder: (context, data, reload) {
            final items = (data['items'] as List).where((i) => i['role'] == widget.role).toList();
            if (items.isEmpty) {
              return ListView(children: [const SizedBox(height: 60), EmptyView(icon: Icons.event_busy, title: 'No lectures on ${data['day_name'] ?? 'this day'}')]);
            }
            return ListView(padding: const EdgeInsets.all(12), children: [
              for (final i in items)
                SessionTile(
                  session: i['session'] as Map,
                  showClasses: widget.role == 'lecturer',
                  subtitlePrefix: widget.role == 'lecturer' ? i['class_name'] as String : null,
                  trailing: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                    StatusChip(i['register'] != null ? i['register']['status'] as String : (i['not_started'] == true ? 'not_started' : 'not_taken')),
                    if (i['checkin'] != null)
                      TextButton.icon(
                        onPressed: () => _openCheckin(i['checkin']['id'] as int),
                        icon: const Icon(Icons.qr_code_2, size: 16),
                        label: Text(i['checkin']['open'] == true ? 'Check-in open' : 'Check-in'),
                      )
                    else if (widget.role == 'lecturer' && i['register'] == null && i['not_started'] != true && isoDate(_date) == isoDate(DateTime.now()))
                      TextButton.icon(onPressed: () => _startCheckin(i), icon: const Icon(Icons.qr_code_2, size: 16), label: const Text('Start check-in')),
                  ]),
                  onTap: () async {
                    if (i['checkin'] != null) {
                      await _openCheckin(i['checkin']['id'] as int);
                    } else if (widget.role == 'rep') {
                      final saved = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => RegisterSheetPage(item: i as Map<String, dynamic>, date: isoDate(_date))));
                      if (saved == true) setState(() => _version++);
                    } else if (i['register'] != null) {
                      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => RegisterDetailPage(id: i['register']['id'] as int)));
                      setState(() => _version++);
                    }
                  },
                ),
            ]);
          },
        ),
      ),
    ]);
  }
}

/// The class representative ticks every student present and submits for approval.
class RegisterSheetPage extends StatefulWidget {
  const RegisterSheetPage({super.key, required this.item, required this.date});
  final Map<String, dynamic> item;
  final String date;

  @override
  State<RegisterSheetPage> createState() => _RegisterSheetPageState();
}

class _RegisterSheetPageState extends State<RegisterSheetPage> {
  Map<String, dynamic>? _sheet;
  final Set<int> _present = {};
  final _topic = TextEditingController();
  final _note = TextEditingController();
  String _query = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final s = widget.item['session'];
    try {
      final sheet = await context.read<AppState>().api.get('/api/attendance/sessions/${s['id']}/sheet?class_id=${widget.item['class_id']}&date=${widget.date}') as Map<String, dynamic>;
      setState(() {
        _sheet = sheet;
        _present
          ..clear()
          ..addAll((sheet['students'] as List).where((x) => x['present'] == 1).map((x) => x['id'] as int));
        _topic.text = sheet['register']?['topic'] ?? '';
        _note.text = sheet['register']?['note'] ?? '';
      });
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await context.read<AppState>().api.post('/api/attendance/registers', {
        'session_id': widget.item['session']['id'],
        'class_id': widget.item['class_id'],
        'date': widget.date,
        'present_student_ids': _present.toList(),
        'topic': _topic.text,
        'note': _note.text,
      });
      if (!mounted) return;
      showMessage(context, 'Submitted to the lecturer for approval');
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.item['session'];
    final sheet = _sheet;
    final scheme = Theme.of(context).colorScheme;
    final canEdit = sheet?['can_edit'] == true;
    final students = (sheet?['students'] as List? ?? []).where((x) => '${x['name']} ${x['identifier'] ?? ''}'.toLowerCase().contains(_query.toLowerCase())).toList();
    final reg = sheet?['register'];
    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${s['course_code']} · ${widget.item['class_name']}'),
          Text('${niceDate(widget.date)} · ${s['start_time']}-${s['end_time']}', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        ]),
        actions: [
          if (canEdit)
            PopupMenuButton<String>(
              onSelected: (v) => setState(() {
                if (v == 'all') {
                  _present.addAll((sheet!['students'] as List).map((x) => x['id'] as int));
                } else {
                  _present.clear();
                }
              }),
              itemBuilder: (_) => const [PopupMenuItem(value: 'all', child: Text('Mark all present')), PopupMenuItem(value: 'none', child: Text('Clear all'))],
            ),
        ],
      ),
      bottomNavigationBar: canEdit
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: FilledButton.icon(
                  onPressed: _busy ? null : _submit,
                  icon: const Icon(Icons.send),
                  label: Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text('${reg != null ? 'Resubmit' : 'Submit'} · ${_present.length}/${(sheet?['students'] as List?)?.length ?? 0} present')),
                ),
              ),
            )
          : null,
      body: sheet == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.all(12), children: [
              if (reg != null)
                Card(
                  color: reg['status'] == 'approved' ? Colors.green.shade50 : reg['status'] == 'rejected' ? scheme.errorContainer : Colors.orange.shade50,
                  child: ListTile(
                    leading: StatusChip(reg['status'] as String),
                    title: Text(reg['status'] == 'approved'
                        ? 'Approved by ${reg['reviewed_by_name']} - locked'
                        : reg['status'] == 'rejected'
                            ? 'Rejected: ${reg['review_note']}'
                            : 'Waiting for ${reg['lecturer_name']} to approve'),
                  ),
                ),
              if (canEdit) ...[
                TextField(controller: _topic, decoration: const InputDecoration(labelText: 'Topic covered (optional)')),
                const SizedBox(height: 8),
                TextField(controller: _note, decoration: const InputDecoration(labelText: 'Note to lecturer (optional)')),
                const SizedBox(height: 8),
              ],
              TextField(onChanged: (v) => setState(() => _query = v), decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Find a student')),
              const SizedBox(height: 8),
              Card(
                child: Column(children: [
                  for (final st in students)
                    CheckboxListTile(
                      value: _present.contains(st['id']),
                      onChanged: canEdit ? (v) => setState(() => v == true ? _present.add(st['id'] as int) : _present.remove(st['id'])) : null,
                      title: Text(st['name'] as String),
                      subtitle: Text(st['identifier'] as String? ?? ''),
                      secondary: _present.contains(st['id']) ? Icon(Icons.check_circle, color: Colors.green.shade600) : const Icon(Icons.radio_button_unchecked),
                    ),
                ]),
              ),
            ]),
    );
  }
}

class _RegisterList extends StatefulWidget {
  const _RegisterList({this.status});
  final String? status;

  @override
  State<_RegisterList> createState() => _RegisterListState();
}

class _RegisterListState extends State<_RegisterList> {
  int _version = 0;

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return AsyncView<List>(
      key: ValueKey('regs-${widget.status}-$_version'),
      load: () async => await api.get('/api/attendance/registers${widget.status != null ? '?status=${widget.status}' : ''}') as List,
      builder: (context, regs, reload) {
        if (regs.isEmpty) {
          return ListView(children: [
            const SizedBox(height: 60),
            EmptyView(icon: Icons.inbox_outlined, title: widget.status == 'submitted' ? 'Nothing waiting for approval' : 'No registers yet'),
          ]);
        }
        return ListView.separated(
          padding: const EdgeInsets.all(12),
          itemCount: regs.length,
          separatorBuilder: (_, _) => const SizedBox(height: 6),
          itemBuilder: (context, i) {
            final r = regs[i];
            return Card(
              margin: EdgeInsets.zero,
              child: ListTile(
                title: Text('${r['course_code']} · ${r['class_name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${niceDate(r['lecture_date'])} ${r['start_time']} · ${r['present_count']}/${r['total']} present\nby ${r['submitted_by_name'] ?? '-'}'),
                isThreeLine: true,
                trailing: StatusChip(r['status'] as String),
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute(builder: (_) => RegisterDetailPage(id: r['id'] as int)));
                  setState(() => _version++);
                },
              ),
            );
          },
        );
      },
    );
  }
}

/// Lecturer view of a submitted list: approve or reject with a note.
class RegisterDetailPage extends StatefulWidget {
  const RegisterDetailPage({super.key, required this.id});
  final int id;

  @override
  State<RegisterDetailPage> createState() => _RegisterDetailPageState();
}

class _RegisterDetailPageState extends State<RegisterDetailPage> {
  int _version = 0;
  final _note = TextEditingController();

  Future<void> _review(String action) async {
    if (action == 'reject' && _note.text.trim().isEmpty) {
      return showMessage(context, 'Add a note explaining why the list is rejected', error: true);
    }
    try {
      await context.read<AppState>().api.post('/api/attendance/registers/${widget.id}/review', {'action': action, 'note': _note.text});
      if (!mounted) return;
      showMessage(context, action == 'approve' ? 'Register approved' : 'Register returned to the class rep');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return Scaffold(
      appBar: AppBar(title: const Text('Attendance register')),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey('reg-${widget.id}-$_version'),
        load: () async => await api.get('/api/attendance/registers/${widget.id}') as Map<String, dynamic>,
        builder: (context, r, reload) {
          final students = (r['students'] as List);
          final present = students.where((s) => s['present'] == 1).toList();
          final absent = students.where((s) => s['present'] != 1).toList();
          return ListView(padding: const EdgeInsets.all(12), children: [
            SectionCard(
              title: '${r['course_code']} ${r['course_name']}',
              trailing: StatusChip(r['status'] as String),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${r['class_name']} · ${niceDate(r['lecture_date'])} · ${r['start_time']}-${r['end_time']} · ${r['room_name']}'),
                Text('Submitted by ${r['submitted_by_name'] ?? '-'}${r['topic'] != null ? ' · Topic: ${r['topic']}' : ''}'),
                if (r['review_note'] != null) Text('Review note: ${r['review_note']}', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                const SizedBox(height: 12),
                StatGrid(children: [
                  StatTile(label: 'Present', value: '${present.length}', color: Colors.green.shade700),
                  StatTile(label: 'Absent', value: '${absent.length}', color: absent.isEmpty ? null : Theme.of(context).colorScheme.error),
                ]),
              ]),
            ),
            if (r['can_review'] == true)
              SectionCard(
                title: 'Your decision',
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  TextField(controller: _note, decoration: const InputDecoration(labelText: 'Note (required when rejecting)')),
                  const SizedBox(height: 10),
                  Row(children: [
                    Expanded(child: FilledButton.icon(onPressed: () => _review('approve'), icon: const Icon(Icons.check), label: const Text('Approve'))),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                        onPressed: () => _review('reject'),
                        icon: const Icon(Icons.close),
                        label: const Text('Reject'),
                      ),
                    ),
                  ]),
                ]),
              ),
            SectionCard(
              title: 'Present (${present.length})',
              child: Column(children: [for (final s in present) _person(s, true)]),
            ),
            SectionCard(
              title: 'Absent (${absent.length})',
              child: Column(children: [for (final s in absent) _person(s, false)]),
            ),
          ]);
        },
      ),
    );
  }

  Widget _person(Map s, bool present) => ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: Icon(present ? Icons.check_circle : Icons.cancel, color: present ? Colors.green.shade600 : Colors.red.shade400),
        title: Text(s['name'] as String),
        subtitle: Text(s['identifier'] as String? ?? ''),
      );
}

/// Students who say they attended but could not check in; the lecturer accepts or rejects.
class _Corrections extends StatefulWidget {
  const _Corrections();

  @override
  State<_Corrections> createState() => _CorrectionsState();
}

class _CorrectionsState extends State<_Corrections> {
  int _version = 0;

  Future<void> _decide(Map c, String action) async {
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(action == 'approve' ? 'Mark ${c['student_name']} present?' : 'Reject this correction?'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('"${c['note']}"'),
          const SizedBox(height: 10),
          TextField(controller: note, decoration: InputDecoration(labelText: action == 'reject' ? 'Reason (required)' : 'Note (optional)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(action == 'approve' ? 'Mark present' : 'Reject')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/attendance/corrections/${c['id']}/review', {'action': action, 'note': note.text.trim()});
      if (mounted) setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return AsyncView<List>(
      key: ValueKey(_version),
      load: () async => await api.get('/api/attendance/corrections') as List,
      builder: (context, list, reload) {
        if (list.isEmpty) return ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.inbox_outlined, title: 'No correction requests')]);
        return ListView(padding: const EdgeInsets.all(12), children: [
          for (final c in list.cast<Map<String, dynamic>>())
            Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text('${c['student_name']}', style: const TextStyle(fontWeight: FontWeight.w600))),
                    if (c['status'] != 'submitted') StatusChip(c['status'] as String),
                  ]),
                  Text('${c['student_identifier'] ?? ''} · ${c['class_name']} · ${c['course_code']} ${niceDate(c['lecture_date'])} ${c['start_time']}'),
                  const SizedBox(height: 4),
                  Text('"${c['note']}"', style: const TextStyle(fontStyle: FontStyle.italic)),
                  if (c['status'] == 'submitted')
                    Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                      TextButton(onPressed: () => _decide(c, 'reject'), child: const Text('Reject')),
                      const SizedBox(width: 8),
                      FilledButton(onPressed: () => _decide(c, 'approve'), child: const Text('Mark present')),
                    ]),
                ]),
              ),
            ),
        ]);
      },
    );
  }
}

class _MyAttendance extends StatefulWidget {
  const _MyAttendance();

  @override
  State<_MyAttendance> createState() => _MyAttendanceState();
}

class _MyAttendanceState extends State<_MyAttendance> {
  int _version = 0;

  bool _recent(String date) => DateTime.now().difference(DateTime.parse('${date}T12:00:00')).inHours <= 72;

  Future<void> _requestCorrection(Map r) async {
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${r['course_code']} on ${niceDate(r['lecture_date'])}'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('You are marked absent. If you attended but could not check in (flat battery, no network), tell your lecturer. Requests are accepted for a short time after the lecture.'),
          const SizedBox(height: 10),
          TextField(controller: note, minLines: 2, maxLines: 4, decoration: const InputDecoration(labelText: 'What happened?', hintText: 'e.g. My phone battery died; I sat in the front row')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Send request')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/attendance/corrections', {'register_id': r['register_id'], 'note': note.text.trim()});
      if (!mounted) return;
      showMessage(context, 'Request sent to your lecturer');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return AsyncView<Map<String, dynamic>>(
      key: ValueKey(_version),
      load: () async => await api.get('/api/attendance/my-history') as Map<String, dynamic>,
      builder: (context, h, reload) {
        final summary = h['summary'] as Map<String, dynamic>;
        final courses = (h['courses'] as List);
        final records = (h['records'] as List);
        final scheme = Theme.of(context).colorScheme;
        return ListView(padding: const EdgeInsets.all(12), children: [
          SectionCard(
            title: 'Overall attendance',
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(rateText(summary['rate'] as num?), style: TextStyle(fontSize: 40, fontWeight: FontWeight.w700, color: rateColor(context, summary['rate'] as num?))),
              Text('${summary['attended']} of ${summary['total']} approved lectures attended', style: TextStyle(color: scheme.onSurfaceVariant)),
              if (summary['rate'] != null && (summary['rate'] as num) < 75)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text('Below 75% - you may not be allowed to sit final exams.', style: TextStyle(color: scheme.error, fontWeight: FontWeight.w600)),
                ),
            ]),
          ),
          SectionCard(
            title: 'By course unit',
            child: Column(children: [
              if (courses.isEmpty) const Text('No attendance recorded yet.'),
              for (final c in courses)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text('${c['code']} ${c['name']}', style: const TextStyle(fontWeight: FontWeight.w600))),
                      Text(rateText(c['rate'] as num?), style: TextStyle(fontWeight: FontWeight.w700, color: rateColor(context, c['rate'] as num?))),
                    ]),
                    const SizedBox(height: 4),
                    LinearProgressIndicator(
                      value: (c['total'] as num) > 0 ? (c['attended'] as num) / (c['total'] as num) : 0,
                      minHeight: 6,
                      borderRadius: BorderRadius.circular(6),
                      color: rateColor(context, c['rate'] as num?),
                    ),
                    Text('${c['attended']}/${c['total']} attended${(c['pending'] as num) > 0 ? ' · ${c['pending']} awaiting approval' : ''}', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                  ]),
                ),
            ]),
          ),
          SectionCard(
            title: 'History',
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Column(children: [
              for (final r in records.take(100))
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(r['present'] == 1 ? Icons.check_circle : Icons.cancel, color: r['present'] == 1 ? Colors.green.shade600 : Colors.red.shade400),
                  title: Text('${r['course_code']} ${r['course_name']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text('${niceDate(r['lecture_date'])} · ${r['start_time']}${r['present'] == 1 && r['method'] == 'qr' ? ' · phone check-in' : ''}'),
                  trailing: r['correction_status'] != null
                      ? Text(r['correction_status'] == 'submitted' ? 'Correction pending' : 'Correction ${r['correction_status']}', style: const TextStyle(fontSize: 12))
                      : r['present'] != 1 && r['register_id'] != null && _recent(r['lecture_date'] as String)
                          ? TextButton(onPressed: () => _requestCorrection(r), child: const Text('I was there'))
                          : r['status'] == 'approved'
                              ? null
                              : StatusChip(r['status'] as String),
                ),
            ]),
          ),
        ]);
      },
    );
  }
}
