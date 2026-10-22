import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'checkin_screen.dart';

const _statusLabels = {
  'scheduled': null,
  'rescheduled': 'Moved here',
  'cancelled': 'Cancelled',
  'moved': 'Moved',
  'no_teaching': 'No teaching',
  'covered': 'Cover',
};

/// The next two weeks of lectures with cancellations, moves, cover and holidays applied.
class UpcomingLecturesScreen extends StatefulWidget {
  const UpcomingLecturesScreen({super.key});

  @override
  State<UpcomingLecturesScreen> createState() => _UpcomingLecturesScreenState();
}

class _UpcomingLecturesScreenState extends State<UpcomingLecturesScreen> {
  int _version = 0;

  Future<void> _startCheckin(Map o) async {
    final app = context.read<AppState>();
    try {
      final r = await app.api.post('/api/checkin/start', {'session_id': o['session_id'], 'date': o['date']}) as Map<String, dynamic>;
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CheckinHostScreen(id: r['id'] as int)));
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _change(Map<String, dynamic> o) async {
    final changed = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => ChangeLectureSheet(occurrence: o));
    if (changed == true) setState(() => _version++);
  }

  Future<void> _undo(Map o) async {
    final app = context.read<AppState>();
    if (o['change_id'] == null) return;
    final ok = await confirmDialog(context, title: 'Undo this change?', message: 'The lecture goes back to its normal time.', confirmLabel: 'Undo');
    if (!ok) return;
    try {
      await app.api.delete('/api/ops/changes/${o['change_id']}');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Upcoming lectures'),
        actions: [IconButton(tooltip: 'Add to my calendar', icon: const Icon(Icons.event_available_outlined), onPressed: () => showCalendarSync(context))],
      ),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey(_version),
        load: () async => await app.api.get('/api/ops/occurrences') as Map<String, dynamic>,
        builder: (context, data, reload) {
          final items = (data['items'] as List).cast<Map<String, dynamic>>();
          if (items.isEmpty) return ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.event_busy, title: 'No lectures in the next two weeks')]);
          final children = <Widget>[];
          String? day;
          for (final o in items) {
            if (o['date'] != day) {
              day = o['date'] as String;
              children.add(Padding(
                padding: const EdgeInsets.fromLTRB(4, 14, 4, 6),
                child: Text(o['today'] == true ? 'Today' : niceDate(day), style: TextStyle(fontWeight: FontWeight.w700, color: scheme.onSurfaceVariant)),
              ));
            }
            final status = o['status'] as String;
            final label = _statusLabels[status];
            final inactive = const ['cancelled', 'moved', 'no_teaching'].contains(status);
            final checkin = o['checkin'] as Map?;
            children.add(Opacity(
              opacity: inactive ? 0.6 : 1,
              child: SessionTile(
                session: {...o, 'id': o['session_id']},
                showClasses: !app.isStudent,
                trailing: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                  if (label != null) _Tag(label, inactive ? scheme.error : Colors.orange.shade800),
                  if (checkin != null && !app.isStudent)
                    TextButton(
                      onPressed: () async {
                        await Navigator.of(context).push(MaterialPageRoute(builder: (_) => CheckinHostScreen(id: checkin['id'] as int)));
                        setState(() => _version++);
                      },
                      child: Text(checkin['open'] == true ? 'Check-in open' : 'Check-in'),
                    )
                  else if (o['can_checkin'] == true)
                    FilledButton.tonal(onPressed: () => _startCheckin(o), child: const Text('Start check-in')),
                ]),
                onTap: () => _details(o),
              ),
            ));
          }
          return ListView(padding: const EdgeInsets.fromLTRB(12, 0, 12, 24), children: children);
        },
      ),
    );
  }

  void _details(Map<String, dynamic> o) {
    final status = o['status'] as String;
    showModalBottomSheet(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${o['course_code']} ${o['course_name']}', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text('${niceDate(o['date'])} · ${o['start_time']}-${o['end_time']} · ${o['room_name']}'),
            Text('${o['lecturer_title'] ?? ''} ${o['lecturer_name']}'.trim()),
            if (o['change_reason'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Reason: ${o['change_reason']}')),
            if (o['original_date'] != null && status == 'rescheduled') Text('Normally on ${niceDate(o['original_date'])}'),
            if (o['covered'] == true) Text(status == 'covered' ? 'Covered by ${o['lecturer_name']} while you are on leave' : 'Cover lecture'),
            const SizedBox(height: 16),
            if (o['can_change'] == true)
              Row(children: [
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: () {
                      Navigator.pop(ctx);
                      _change(o);
                    },
                    icon: const Icon(Icons.edit_calendar_outlined),
                    label: const Text('Cancel or move'),
                  ),
                ),
                if (status == 'rescheduled') ...[
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: () {
                      Navigator.pop(ctx);
                      _undo(o);
                    },
                    child: const Text('Undo move'),
                  ),
                ],
              ]),
            if (status == 'cancelled' && o['change_id'] != null && !context.read<AppState>().isStudent)
              OutlinedButton(
                onPressed: () {
                  Navigator.pop(ctx);
                  _undo(o);
                },
                child: const Text('Undo cancellation'),
              ),
          ]),
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
        child: Text(text, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
      );
}

/// Cancel a lecture, or move it to a clash-free time the server suggests.
class ChangeLectureSheet extends StatefulWidget {
  const ChangeLectureSheet({super.key, required this.occurrence});
  final Map<String, dynamic> occurrence;

  @override
  State<ChangeLectureSheet> createState() => _ChangeLectureSheetState();
}

class _ChangeLectureSheetState extends State<ChangeLectureSheet> {
  String _action = 'move';
  final _reason = TextEditingController();
  List<Map<String, dynamic>>? _slots;
  Map<String, dynamic>? _slot;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _loadSlots();
  }

  Future<void> _loadSlots() async {
    final o = widget.occurrence;
    try {
      final list = await context.read<AppState>().api.get('/api/ops/sessions/${o['session_id']}/suggestions?date=${o['date']}') as List;
      if (mounted) setState(() => _slots = list.cast<Map<String, dynamic>>());
    } catch (e) {
      if (mounted) {
        setState(() => _slots = []);
        showError(context, e);
      }
    }
  }

  Future<void> _save() async {
    final o = widget.occurrence;
    setState(() => _busy = true);
    try {
      await runWithConfirm(
        context,
        (force) => context.read<AppState>().api.post('/api/ops/changes', {
          'session_id': o['session_id'],
          'date': o['date'],
          'action': _action,
          'reason': _reason.text.trim(),
          if (_action == 'move') ...{'new_date': _slot!['date'], 'new_start': _slot!['start_time'], 'new_end': _slot!['end_time'], 'new_room_id': _slot!['room_id']},
          'force': force,
        }),
      );
      if (!mounted) return;
      showMessage(context, _action == 'cancel' ? 'Lecture cancelled; students have been told' : 'Lecture moved; students have been told');
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.occurrence;
    final scheme = Theme.of(context).colorScheme;
    final ready = _reason.text.trim().length >= 3 && (_action == 'cancel' || _slot != null);
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.8,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('${o['course_code']} on ${niceDate(o['date'])}', style: Theme.of(context).textTheme.titleLarge),
          Text('${o['start_time']}-${o['end_time']} · ${o['room_name']}', style: TextStyle(color: scheme.onSurfaceVariant)),
          const SizedBox(height: 12),
          SegmentedButton<String>(
            segments: const [ButtonSegment(value: 'move', label: Text('Move'), icon: Icon(Icons.update)), ButtonSegment(value: 'cancel', label: Text('Cancel'), icon: Icon(Icons.event_busy))],
            selected: {_action},
            onSelectionChanged: (v) => setState(() => _action = v.first),
          ),
          const SizedBox(height: 12),
          TextField(controller: _reason, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Reason (students see this)')),
          const SizedBox(height: 12),
          if (_action == 'move') ...[
            Text('Free times (no clash for you, the classes or the room)', style: TextStyle(fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
            const SizedBox(height: 6),
            Expanded(
              child: _slots == null
                  ? const Center(child: CircularProgressIndicator())
                  : _slots!.isEmpty
                      ? const Center(child: Text('No free times found in the next two weeks. Use the web app to choose a time by hand.', textAlign: TextAlign.center))
                      : ListView(children: [
                          for (final s in _slots!)
                            Card(
                              margin: const EdgeInsets.only(bottom: 6),
                              color: identical(s, _slot) ? scheme.primaryContainer : null,
                              child: ListTile(
                                onTap: () => setState(() => _slot = s),
                                leading: Icon(identical(s, _slot) ? Icons.radio_button_checked : Icons.radio_button_off),
                                title: Text('${niceDate(s['date'])} · ${s['start_time']}-${s['end_time']}'),
                                subtitle: Text('${s['room_name']} (${s['room_capacity']} seats)'),
                              ),
                            ),
                        ]),
            ),
          ] else
            const Spacer(),
          const SizedBox(height: 8),
          FilledButton(
            style: _action == 'cancel' ? FilledButton.styleFrom(backgroundColor: scheme.error) : null,
            onPressed: ready && !_busy ? _save : null,
            child: Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(_action == 'cancel' ? 'Cancel this lecture' : 'Move lecture')),
          ),
        ]),
      ),
    );
  }
}

/// Subscribe a phone or Google calendar to the user's lectures and exams.
Future<void> showCalendarSync(BuildContext context) async {
  final app = context.read<AppState>();
  Map<String, dynamic> link;
  try {
    link = await app.api.get('/api/ops/calendar-link') as Map<String, dynamic>;
  } catch (e) {
    if (context.mounted) showError(context, e);
    return;
  }
  if (!context.mounted) return;
  await showModalBottomSheet(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Add to my calendar', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 6),
          const Text('Your lectures and exams appear in your calendar app and update by themselves when a lecture is moved or cancelled.'),
          const SizedBox(height: 16),
          FilledButton.icon(
            icon: const Icon(Icons.calendar_month),
            label: const Text('Google Calendar'),
            onPressed: () => launchUrl(Uri.parse(link['google'] as String), mode: LaunchMode.externalApplication),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            icon: const Icon(Icons.event_available),
            label: const Text('Phone calendar (Apple, Outlook...)'),
            onPressed: () => launchUrl(Uri.parse(link['webcal'] as String), mode: LaunchMode.externalApplication),
          ),
          const SizedBox(height: 8),
          TextButton.icon(
            icon: const Icon(Icons.copy),
            label: const Text('Copy the link'),
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: link['url'] as String));
              if (ctx.mounted) showMessage(ctx, 'Calendar link copied. Keep it private: anyone with it can see your timetable.');
            },
          ),
        ]),
      ),
    ),
  );
}

/// Lectures in the last two weeks where neither a register nor a check-in was taken.
class MissedLecturesScreen extends StatelessWidget {
  const MissedLecturesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return Scaffold(
      appBar: AppBar(title: const Text('No attendance taken')),
      body: AsyncView<Map<String, dynamic>>(
        load: () async => await api.get('/api/ops/missed') as Map<String, dynamic>,
        builder: (context, data, reload) {
          final items = (data['items'] as List).cast<Map<String, dynamic>>();
          if (items.isEmpty) return ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.task_alt, title: 'Every lecture had attendance taken')]);
          return ListView(padding: const EdgeInsets.all(12), children: [
            Text('Last 14 days', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
            const SizedBox(height: 8),
            for (final o in items) SessionTile(session: {...o, 'id': o['session_id']}, subtitlePrefix: niceDate(o['date'])),
          ]);
        },
      ),
    );
  }
}
