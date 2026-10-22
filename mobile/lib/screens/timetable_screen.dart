import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/app_state.dart';
import '../widgets/common.dart';
import 'lectures_screen.dart';
import 'home_shell.dart';

enum _View { mine, all, classView, lecturer, room }

class TimetableScreen extends StatefulWidget {
  const TimetableScreen({super.key});

  @override
  State<TimetableScreen> createState() => _TimetableScreenState();
}

class _TimetableScreenState extends State<TimetableScreen> {
  late _View _view;
  String? _entity;
  int _version = 0;
  List<Map<String, dynamic>> _options = [];

  @override
  void initState() {
    super.initState();
    final app = context.read<AppState>();
    _view = app.teaches || app.isStudent ? _View.mine : _View.all;
  }

  String get _query {
    return switch (_view) {
      _View.mine => 'mine=1',
      _View.all => '',
      _View.classView => 'class_id=$_entity',
      _View.lecturer => 'lecturer_id=$_entity',
      _View.room => 'room_id=$_entity',
    };
  }

  Future<void> _selectView(_View v) async {
    final api = context.read<AppState>().api;
    List<Map<String, dynamic>> options = [];
    try {
      if (v == _View.classView) {
        options = ((await api.get('/api/classes')) as List).map((c) => {'id': c['id'], 'label': c['name']}).toList().cast();
      } else if (v == _View.lecturer) {
        options = ((await api.get('/api/users?roles=lecturer,hod,dean&active=1')) as List)
            .map((u) => {'id': u['id'], 'label': '${u['title'] ?? ''} ${u['name']}'.trim()})
            .toList()
            .cast();
      } else if (v == _View.room) {
        options = ((await api.get('/api/rooms')) as List).map((r) => {'id': r['id'], 'label': '${r['name']} (${r['capacity']})'}).toList().cast();
      }
    } catch (e) {
      if (mounted) showError(context, e);
      return;
    }
    setState(() {
      _view = v;
      _options = options;
      _entity = options.isNotEmpty ? '${options.first['id']}' : null;
      _version++;
    });
  }

  Future<void> _export(String format) async {
    try {
      await context.read<AppState>().openExport('/api/timetable/export?format=$format${_query.isEmpty ? '' : '&$_query'}');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _generate() async {
    var clear = false;
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Generate timetable'),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Places every allocation automatically: cross-cutting units first, no room, lecturer or class double-booked, smallest room that fits.'),
            const SizedBox(height: 8),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: clear,
              onChanged: (v) => setLocal(() => clear = v ?? false),
              title: const Text('Clear generated sessions first'),
              subtitle: const Text('Sessions with attendance are kept'),
            ),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Generate')),
          ],
        ),
      ),
    );
    if (go != true || !mounted) return;
    try {
      final r = await context.read<AppState>().api.post('/api/timetable/generate', {'clear_existing': clear});
      if (!mounted) return;
      final unplaced = (r['unplaced'] as List);
      await showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Timetable generated'),
          content: Text(
            '${r['placed']} session(s) placed, ${r['total_sessions']} in total.\n'
            '${unplaced.isEmpty ? 'Every allocation is fully scheduled with no collisions.' : unplaced.map((u) => '• ${u['code']}: ${u['reason']}').join('\n')}',
          ),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK'))],
        ),
      );
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  void _sessionDetails(Map<String, dynamic> s) {
    final app = context.read<AppState>();
    showModalBottomSheet(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text('${s['course_code']} ${s['course_name']}', style: Theme.of(ctx).textTheme.titleLarge)),
              if (s['is_cross_cutting'] == 1) const CcBadge(),
            ]),
            const SizedBox(height: 12),
            _row(Icons.schedule, '${dayNames[s['day_of_week']]} ${s['start_time']}-${s['end_time']}'),
            _row(Icons.place_outlined, '${s['room_name']}${s['room_building'] != null ? ', ${s['room_building']}' : ''} · ${s['room_capacity']} seats'),
            _row(Icons.person_outline, '${s['lecturer_title'] ?? ''} ${s['lecturer_name']}'.trim()),
            _row(Icons.groups_outlined, (s['classes'] as List).map((c) => c['name']).join(', ')),
            if (app.isManager) ...[
              const SizedBox(height: 12),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(foregroundColor: Theme.of(ctx).colorScheme.error),
                icon: const Icon(Icons.delete_outline),
                label: const Text('Remove from timetable'),
                onPressed: () async {
                  Navigator.pop(ctx);
                  final ok = await confirmDialog(context, title: 'Remove session?', message: 'Remove ${s['course_code']} on ${dayNames[s['day_of_week']]} ${s['start_time']}?', confirmLabel: 'Remove', danger: true);
                  if (!ok || !mounted) return;
                  try {
                    await runWithConfirm(context, (force) => app.api.delete('/api/timetable/sessions/${s['id']}${force ? '?force=1' : ''}'));
                    setState(() => _version++);
                  } catch (e) {
                    if (mounted) showError(context, e);
                  }
                },
              ),
            ],
          ]),
        ),
      ),
    );
  }

  Widget _row(IconData icon, String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [Icon(icon, size: 18), const SizedBox(width: 10), Expanded(child: Text(text))]),
      );

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final canSwitch = app.isStaff;
    return Scaffold(
      appBar: AppBar(
        title: const BrandTitle('Timetable'),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.download_outlined),
            tooltip: 'Export',
            onSelected: _export,
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'pdf', child: ListTile(leading: Icon(Icons.picture_as_pdf_outlined), title: Text('Export PDF'))),
              PopupMenuItem(value: 'xlsx', child: ListTile(leading: Icon(Icons.table_view_outlined), title: Text('Export Excel'))),
            ],
          ),
          if (app.teaches || app.isStudent)
            IconButton(
              tooltip: 'Upcoming lectures and changes',
              icon: const Icon(Icons.event_repeat_outlined),
              onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const UpcomingLecturesScreen())),
            ),
          if (app.isAdmin) IconButton(tooltip: 'Generate', icon: const Icon(Icons.auto_fix_high), onPressed: _generate),
        ],
      ),
      floatingActionButton: app.isManager
          ? FloatingActionButton.extended(
              onPressed: () async {
                final added = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, showDragHandle: true, builder: (_) => const _AddSessionSheet());
                if (added == true) setState(() => _version++);
              },
              icon: const Icon(Icons.add),
              label: const Text('Add session'),
            )
          : null,
      body: Column(children: [
        if (canSwitch)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Row(children: [
              for (final (v, label) in [
                if (app.teaches) (_View.mine, 'Mine'),
                (_View.all, app.isManager && !app.isAdmin ? 'My unit' : 'Master'),
                (_View.classView, 'Class'),
                (_View.lecturer, 'Lecturer'),
                (_View.room, 'Room'),
              ])
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(label: Text(label), selected: _view == v, onSelected: (_) => _selectView(v)),
                ),
            ]),
          ),
        if (_options.isNotEmpty && const [_View.classView, _View.lecturer, _View.room].contains(_view))
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: DropdownButtonFormField<String>(
              key: ValueKey(_view),
              initialValue: _entity,
              isExpanded: true,
              items: [for (final o in _options) DropdownMenuItem(value: '${o['id']}', child: Text(o['label'] as String, overflow: TextOverflow.ellipsis))],
              onChanged: (v) => setState(() {
                _entity = v;
                _version++;
              }),
            ),
          ),
        Expanded(
          child: AsyncView<Map<String, dynamic>>(
            key: ValueKey('tt-$_view-$_entity-$_version'),
            load: () async => await app.api.get('/api/timetable${_query.isEmpty ? '' : '?$_query'}') as Map<String, dynamic>,
            builder: (context, data, reload) => _WeekTabs(
              data: data,
              showClasses: !(app.isStudent || _view == _View.classView),
              onTap: _sessionDetails,
            ),
          ),
        ),
      ]),
    );
  }
}

/// Day tabs, each with that day's lectures. Opens on today.
class _WeekTabs extends StatelessWidget {
  const _WeekTabs({required this.data, required this.showClasses, required this.onTap});
  final Map<String, dynamic> data;
  final bool showClasses;
  final void Function(Map<String, dynamic>) onTap;

  @override
  Widget build(BuildContext context) {
    final sessions = (data['sessions'] as List).cast<Map<String, dynamic>>();
    final teaching = ((data['settings']?['teaching_days'] as List?) ?? [1, 2, 3, 4, 5]).cast<num>().map((e) => e.toInt());
    final days = {...teaching, ...sessions.map((s) => (s['day_of_week'] as num).toInt())}.toList()..sort();
    final today = DateTime.now().weekday;
    final initial = days.contains(today) ? days.indexOf(today) : 0;
    final scheme = Theme.of(context).colorScheme;
    return DefaultTabController(
      length: days.length,
      initialIndex: initial,
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: Row(children: [
            Expanded(child: Text(data['title'] as String? ?? '', style: const TextStyle(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
            Text('${sessions.length} sessions', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12.5)),
          ]),
        ),
        TabBar(
          isScrollable: days.length > 5,
          tabs: [for (final d in days) Tab(text: d == today ? '${dayShort[d]} •' : dayShort[d])],
        ),
        Expanded(
          child: TabBarView(children: [
            for (final d in days)
              Builder(builder: (context) {
                final list = sessions.where((s) => s['day_of_week'] == d).toList()..sort((a, b) => (a['start_time'] as String).compareTo(b['start_time'] as String));
                if (list.isEmpty) {
                  return ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.event_available, title: 'No lectures', message: 'Nothing scheduled on this day.')]);
                }
                return ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 90), children: [
                  for (final s in list) SessionTile(session: s, showClasses: showClasses, onTap: () => onTap(s)),
                ]);
              }),
          ]),
        ),
      ]),
    );
  }
}

/// Manually place a lecture; the server rejects any room / lecturer / class clash.
class _AddSessionSheet extends StatefulWidget {
  const _AddSessionSheet();

  @override
  State<_AddSessionSheet> createState() => _AddSessionSheetState();
}

class _AddSessionSheetState extends State<_AddSessionSheet> {
  List allocations = [];
  List rooms = [];
  String? allocationId;
  String? roomId;
  int day = 1;
  TimeOfDay start = const TimeOfDay(hour: 8, minute: 0);
  TimeOfDay end = const TimeOfDay(hour: 10, minute: 0);
  List<String> conflicts = [];
  bool busy = false;

  @override
  void initState() {
    super.initState();
    final api = context.read<AppState>().api;
    Future.wait([api.get('/api/allocations'), api.get('/api/rooms')]).then((r) {
      if (mounted) {
        setState(() {
          allocations = r[0] as List;
          rooms = (r[1] as List).where((x) => x['active'] == 1).toList();
        });
      }
    });
  }

  String _fmt(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  Future<void> _save() async {
    setState(() {
      busy = true;
      conflicts = [];
    });
    final api = context.read<AppState>().api;
    try {
      final body = {'allocation_id': allocationId, 'room_id': roomId, 'day_of_week': day, 'start_time': _fmt(start), 'end_time': _fmt(end)};
      final res = await runWithConfirm(context, (force) => api.post('/api/timetable/sessions', {...body, 'force': force}));
      if (res != null && mounted) {
        showMessage(context, 'Session added');
        Navigator.pop(context, true);
      }
    } on ApiException catch (e) {
      final list = (e.data['conflicts'] as List?)?.map((c) => c['message'] as String).toList();
      if (list != null) {
        setState(() => conflicts = list);
      } else if (mounted) {
        showError(context, e);
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(context).viewInsets.bottom + 20),
      child: SingleChildScrollView(
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Add a lecture session', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Allocation'),
            items: [
              for (final a in allocations)
                DropdownMenuItem(
                  value: '${a['id']}',
                  child: Text('${a['is_cross_cutting'] == 1 ? '[CC] ' : ''}${a['code']} · ${a['lecturer_name']} · ${(a['classes'] as List).map((c) => c['name']).join(', ')}', overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: (v) => setState(() => allocationId = v),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<int>(
            initialValue: day,
            decoration: const InputDecoration(labelText: 'Day'),
            items: [for (var d = 1; d <= 6; d++) DropdownMenuItem(value: d, child: Text(dayNames[d]))],
            onChanged: (v) => setState(() => day = v ?? 1),
          ),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                icon: const Icon(Icons.schedule),
                label: Text('Start ${_fmt(start)}'),
                onPressed: () async {
                  final t = await showTimePicker(context: context, initialTime: start);
                  if (t != null) setState(() => start = t);
                },
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton.icon(
                icon: const Icon(Icons.schedule),
                label: Text('End ${_fmt(end)}'),
                onPressed: () async {
                  final t = await showTimePicker(context: context, initialTime: end);
                  if (t != null) setState(() => end = t);
                },
              ),
            ),
          ]),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Room'),
            items: [for (final r in rooms) DropdownMenuItem(value: '${r['id']}', child: Text('${r['name']} · ${r['capacity']} seats'))],
            onChanged: (v) => setState(() => roomId = v),
          ),
          if (conflicts.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Theme.of(context).colorScheme.errorContainer, borderRadius: BorderRadius.circular(10)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Collision detected', style: TextStyle(fontWeight: FontWeight.w700)),
                for (final c in conflicts) Text('• $c'),
              ]),
            ),
          ],
          const SizedBox(height: 16),
          FilledButton(onPressed: busy || allocationId == null || roomId == null ? null : _save, child: const Text('Add session')),
        ]),
      ),
    );
  }
}
