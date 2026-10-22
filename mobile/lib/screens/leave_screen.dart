import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

Color _leaveColor(BuildContext context, String status) => switch (status) {
      'approved' => Colors.green.shade700,
      'rejected' || 'cancelled' => Theme.of(context).colorScheme.error,
      _ => Colors.orange.shade800,
    };

/// Short-term leave: the lecturer asks, the HoD checks and arranges cover, the Dean approves.
class LeaveScreen extends StatefulWidget {
  const LeaveScreen({super.key});

  @override
  State<LeaveScreen> createState() => _LeaveScreenState();
}

class _LeaveScreenState extends State<LeaveScreen> {
  int _version = 0;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final reviews = app.isManager;
    final tabs = <(String, String)>[
      if (app.teaches) ('My leave', 'mine'),
      if (reviews) ('To review', 'review'),
      if (reviews) ('All', 'all'),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Leave'),
          bottom: tabs.length > 1 ? TabBar(tabs: [for (final t in tabs) Tab(text: t.$1)]) : null,
        ),
        floatingActionButton: app.teaches
            ? FloatingActionButton.extended(
                onPressed: () async {
                  final made = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _NewLeaveSheet());
                  if (made == true) setState(() => _version++);
                },
                icon: const Icon(Icons.add),
                label: const Text('Request leave'),
              )
            : null,
        body: TabBarView(children: [
          for (final t in tabs)
            AsyncView<List>(
              key: ValueKey('${t.$2}-$_version'),
              load: () async => await app.api.get('/api/ops/leave${t.$2 == 'all' ? '' : '?view=${t.$2}'}') as List,
              builder: (context, list, reload) {
                if (list.isEmpty) {
                  return ListView(children: [const SizedBox(height: 60), EmptyView(icon: Icons.beach_access_outlined, title: t.$2 == 'review' ? 'Nothing waiting for you' : 'No leave requests')]);
                }
                return ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 90), children: [
                  for (final lr in list.cast<Map<String, dynamic>>())
                    Card(
                      margin: const EdgeInsets.only(bottom: 8),
                      child: ListTile(
                        title: Text(t.$2 == 'mine' ? '${niceDate(lr['start_date'])} to ${niceDate(lr['end_date'])}' : '${lr['lecturer_name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: Text([if (t.$2 != 'mine') '${niceDate(lr['start_date'])} to ${niceDate(lr['end_date'])}', lr['reason'] as String].join('\n'), maxLines: 3, overflow: TextOverflow.ellipsis),
                        trailing: Text(lr['status_label'] as String, style: TextStyle(color: _leaveColor(context, lr['status'] as String), fontWeight: FontWeight.w600, fontSize: 12.5)),
                        onTap: () async {
                          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => LeaveDetailScreen(id: lr['id'] as int)));
                          setState(() => _version++);
                        },
                      ),
                    ),
                ]);
              },
            ),
        ]),
      ),
    );
  }
}

class _NewLeaveSheet extends StatefulWidget {
  const _NewLeaveSheet();

  @override
  State<_NewLeaveSheet> createState() => _NewLeaveSheetState();
}

class _NewLeaveSheetState extends State<_NewLeaveSheet> {
  DateTimeRange? _range;
  final _reason = TextEditingController();
  bool _busy = false;

  Future<void> _pick() async {
    final now = DateTime.now();
    final r = await showDateRangePicker(context: context, firstDate: DateTime(now.year, now.month, now.day), lastDate: now.add(const Duration(days: 365)), initialDateRange: _range);
    if (r != null) setState(() => _range = r);
  }

  Future<void> _send() async {
    setState(() => _busy = true);
    try {
      await context.read<AppState>().api.post('/api/ops/leave', {'start_date': isoDate(_range!.start), 'end_date': isoDate(_range!.end), 'reason': _reason.text.trim()});
      if (!mounted) return;
      showMessage(context, 'Leave request sent for checking');
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _range;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Request leave', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 4),
        const Text('Your HoD checks the request and arranges cover for your lectures; the Dean approves it.'),
        const SizedBox(height: 12),
        OutlinedButton.icon(onPressed: _pick, icon: const Icon(Icons.date_range), label: Text(r == null ? 'Choose dates' : '${niceDate(isoDate(r.start))} to ${niceDate(isoDate(r.end))}')),
        const SizedBox(height: 10),
        TextField(controller: _reason, minLines: 2, maxLines: 4, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Reason')),
        const SizedBox(height: 12),
        FilledButton(onPressed: r != null && _reason.text.trim().length >= 5 && !_busy ? _send : null, child: const Text('Send request')),
      ]),
    );
  }
}

class LeaveDetailScreen extends StatefulWidget {
  const LeaveDetailScreen({super.key, required this.id});
  final int id;

  @override
  State<LeaveDetailScreen> createState() => _LeaveDetailScreenState();
}

class _LeaveDetailScreenState extends State<LeaveDetailScreen> {
  int _version = 0;

  Future<void> _decide(Map lr, String action) async {
    final note = TextEditingController();
    final stage = lr['status'] == 'submitted' ? 'HoD check' : 'Dean approval';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(action == 'approve' ? (lr['status'] == 'submitted' ? 'Checked: pass to the Dean?' : 'Approve this leave?') : 'Turn down this leave?'),
        content: TextField(controller: note, decoration: InputDecoration(labelText: action == 'reject' ? 'Reason (required)' : 'Note (optional)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(action == 'approve' ? 'Confirm $stage' : 'Turn down')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/ops/leave/${widget.id}/review', {'action': action, 'note': note.text.trim()});
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _cancel() async {
    final ok = await confirmDialog(context, title: 'Cancel your leave request?', message: 'Any cover arranged stays until your HoD removes it.', confirmLabel: 'Cancel request', danger: true);
    if (!ok || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/ops/leave/${widget.id}/cancel');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _cover(Map o, String? value) async {
    final api = context.read<AppState>().api;
    if (value == 'cancel') {
      final ok = await confirmDialog(context, title: 'Cancel ${o['course_code']} on ${niceDate(o['date'])}?', message: 'Students are told the lecture will not take place.', confirmLabel: 'Cancel lecture', danger: true);
      if (!ok || !mounted) {
        setState(() => _version++);
        return;
      }
    }
    try {
      await api.put('/api/ops/leave/${widget.id}/covers', {
        'session_id': o['session_id'],
        'date': o['date'],
        if (value == 'cancel') 'cancel': true else 'substitute_id': value == null || value.isEmpty ? null : int.parse(value),
      });
      if (!mounted) return;
      showMessage(context, value == 'cancel' ? 'Lecture cancelled; students have been told' : 'Cover updated');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Leave request')),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey(_version),
        load: () async => await app.api.get('/api/ops/leave/${widget.id}') as Map<String, dynamic>,
        builder: (context, lr, reload) {
          final lectures = (lr['lectures'] as List).cast<Map<String, dynamic>>();
          final status = lr['status'] as String;
          final mine = lr['lecturer_id'] == app.user?['id'];
          Widget step(String label, bool done, String? by, String? note) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(done ? Icons.check_circle : Icons.radio_button_unchecked, color: done ? Colors.green.shade600 : scheme.outline),
                title: Text(label),
                subtitle: by != null ? Text([by, note].whereType<String>().join(': ')) : null,
              );
          return ListView(padding: const EdgeInsets.all(12), children: [
            SectionCard(
              title: '${lr['lecturer_title'] ?? ''} ${lr['lecturer_name']}'.trim(),
              trailing: Text(lr['status_label'] as String, style: TextStyle(color: _leaveColor(context, status), fontWeight: FontWeight.w700)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${niceDate(lr['start_date'])} to ${niceDate(lr['end_date'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(lr['reason'] as String),
                const SizedBox(height: 8),
                step('Requested', true, null, null),
                step('Checked by the HoD', lr['hod_at'] != null || status == 'hod_checked' || status == 'approved', lr['hod_name'] as String?, lr['hod_note'] as String?),
                step('Approved by the Dean', status == 'approved', lr['dean_name'] as String?, lr['dean_note'] as String?),
                if (lr['can_act'] == true) ...[
                  const SizedBox(height: 8),
                  Row(children: [
                    Expanded(child: FilledButton(onPressed: () => _decide(lr, 'approve'), child: Text(status == 'submitted' ? 'Checked' : 'Approve'))),
                    const SizedBox(width: 8),
                    Expanded(child: OutlinedButton(style: OutlinedButton.styleFrom(foregroundColor: scheme.error), onPressed: () => _decide(lr, 'reject'), child: const Text('Turn down'))),
                  ]),
                ],
                if (mine && const ['submitted', 'hod_checked', 'approved'].contains(status))
                  Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _cancel, child: const Text('Cancel my request'))),
              ]),
            ),
            SectionCard(
              title: 'Lectures during the leave (${lectures.length})',
              child: Column(children: [
                if (lectures.isEmpty) const Text('No lectures fall in these dates.'),
                for (final o in lectures)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${o['course_code']} · ${niceDate(o['date'])} ${o['start_time']}-${o['end_time']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text('${o['room_name']} · ${(o['classes'] as List).map((c) => c['name']).join(', ')}', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13)),
                      if (o['status'] == 'cancelled')
                        Text('Cancelled', style: TextStyle(color: scheme.error))
                      else if (lr['can_assign_covers'] == true && o['candidates'] != null)
                        DropdownButtonFormField<String>(
                          initialValue: o['cover'] != null ? '${o['cover']['substitute_id']}' : '',
                          isExpanded: true,
                          decoration: const InputDecoration(labelText: 'Cover lecturer'),
                          items: [
                            const DropdownMenuItem(value: '', child: Text('No cover yet')),
                            for (final c in (o['candidates'] as List))
                              DropdownMenuItem(value: '${c['id']}', child: Text('${c['name']}${c['same_department'] == true ? '' : ' (other dept.)'}', overflow: TextOverflow.ellipsis)),
                            if (o['cover'] != null && !(o['candidates'] as List).any((c) => c['id'] == o['cover']['substitute_id']))
                              DropdownMenuItem(value: '${o['cover']['substitute_id']}', child: Text('${o['cover']['substitute_name']}')),
                            const DropdownMenuItem(value: 'cancel', child: Text('Cancel this lecture')),
                          ],
                          onChanged: (v) => _cover(o, v),
                        )
                      else
                        Text(o['cover'] != null ? 'Cover: ${o['cover']['substitute_name']}' : 'No cover yet', style: TextStyle(color: o['cover'] != null ? Colors.green.shade700 : Colors.orange.shade800)),
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
