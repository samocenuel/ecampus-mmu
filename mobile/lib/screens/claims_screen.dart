import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// Part-time pay claims: lecturers claim teaching hours and tasks; the HoD, Dean and HR approve.
String money(num? amount, [String? currency]) {
  final c = currency ?? 'UGX';
  final v = amount ?? 0;
  return '$c ${NumberFormat(v % 1 == 0 ? '#,##0' : '#,##0.00').format(v)}';
}

String _qty(num n) => n % 1 == 0 ? '${n.toInt()}' : n.toStringAsFixed(2);
String _plural(num n, String word) => '${_qty(n)} ${n == 1 ? word : '${word}s'}';

(Color, String) claimStatus(BuildContext context, Map c) {
  final label = c['status_label'] as String? ?? '${c['status']}';
  final color = switch (c['status']) {
    'paid' => Colors.green.shade700,
    'rejected' => Theme.of(context).colorScheme.error,
    'draft' => Colors.blueGrey,
    'hr_verified' => Theme.of(context).colorScheme.primary,
    'dean_approved' => Colors.blue.shade700,
    _ => Colors.orange.shade800,
  };
  return (color, label);
}

class ClaimStatusChip extends StatelessWidget {
  const ClaimStatusChip(this.claim, {super.key});
  final Map claim;

  @override
  Widget build(BuildContext context) {
    final (color, label) = claimStatus(context, claim);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class ClaimsScreen extends StatefulWidget {
  const ClaimsScreen({super.key, this.asTab = false});
  final bool asTab;

  @override
  State<ClaimsScreen> createState() => _ClaimsScreenState();
}

class _ClaimsScreenState extends State<ClaimsScreen> {
  late String _view;
  int _version = 0;

  @override
  void initState() {
    super.initState();
    final app = context.read<AppState>();
    _view = app.approvesClaims ? 'queue' : 'mine';
  }

  Future<void> _newClaim() async {
    final app = context.read<AppState>();
    final now = DateTime.now();
    final months = [for (var i = 0; i < 4; i++) DateTime(now.year, now.month - i, 1)];
    final month = await showModalBottomSheet<DateTime>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 4),
              child: Text('New pay claim', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('Lectures whose attendance you approved are added automatically. Choose the month:'),
            ),
            for (final m in months)
              ListTile(
                leading: const Icon(Icons.calendar_month_outlined),
                title: Text(DateFormat('MMMM yyyy').format(m)),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(sheet).pop(m),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (month == null || !mounted) return;
    final last = DateTime(month.year, month.month + 1, 0);
    final end = last.isAfter(now) ? now : last;
    try {
      final claim = await app.api.post('/api/claims', {
        'period_start': isoDate(month),
        'period_end': isoDate(end),
        'title': DateFormat('MMMM yyyy').format(month),
      });
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ClaimDetailScreen(id: claim['id'] as int)));
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final views = [if (app.isPartTimer) ('mine', 'Mine'), if (app.approvesClaims) ('queue', 'Awaiting me'), if (app.approvesClaims) ('all', 'All')];
    return Scaffold(
      appBar: AppBar(title: const Text('Pay claims'), automaticallyImplyLeading: !widget.asTab),
      floatingActionButton: app.isPartTimer
          ? FloatingActionButton.extended(onPressed: _newClaim, icon: const Icon(Icons.add), label: const Text('New claim'))
          : null,
      body: Column(
        children: [
          if (views.length > 1)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: SegmentedButton<String>(
                segments: [for (final (v, l) in views) ButtonSegment(value: v, label: Text(l))],
                selected: {_view},
                onSelectionChanged: (s) => setState(() => _view = s.first),
              ),
            ),
          Expanded(
            child: AsyncView<List>(
              key: ValueKey('$_view-$_version'),
              load: () async => await app.api.get('/api/claims?view=$_view') as List,
              builder: (context, rows, reload) {
                if (rows.isEmpty) {
                  return ListView(
                    children: [
                      EmptyView(
                        icon: Icons.account_balance_wallet_outlined,
                        title: _view == 'queue' ? 'Nothing is waiting for you' : 'No claims yet',
                        message: app.isPartTimer && _view == 'mine' ? 'Tap New claim to claim a month of lectures and tasks.' : null,
                      ),
                    ],
                  );
                }
                return ListView.builder(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 88),
                  itemCount: rows.length,
                  itemBuilder: (context, i) {
                    final c = rows[i] as Map;
                    return Card(
                      child: ListTile(
                        title: Text(_view == 'mine' ? '${c['title']}' : '${c['lecturer_name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: Text(
                          [
                            if (_view != 'mine') '${c['title']} · ${c['department_name'] ?? ''}',
                            '${_qty(c['teaching_hours'] as num)} h teaching · ${_plural(c['task_count'] as num, 'task')}',
                          ].join('\n'),
                        ),
                        isThreeLine: _view != 'mine',
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Text(money(c['total'] as num?, c['currency'] as String?), style: const TextStyle(fontWeight: FontWeight.w700)),
                            const SizedBox(height: 4),
                            ClaimStatusChip(c),
                          ],
                        ),
                        onTap: () async {
                          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ClaimDetailScreen(id: c['id'] as int)));
                          await reload();
                        },
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class ClaimDetailScreen extends StatefulWidget {
  const ClaimDetailScreen({super.key, required this.id});
  final int id;

  @override
  State<ClaimDetailScreen> createState() => _ClaimDetailScreenState();
}

class _ClaimDetailScreenState extends State<ClaimDetailScreen> {
  int _version = 0;
  bool _busy = false;

  Future<void> _run(Future<void> Function() action, String message) async {
    setState(() => _busy = true);
    try {
      await action();
      if (mounted) showMessage(context, message);
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decide(Map claim, String mode) async {
    final note = TextEditingController();
    final reference = TextEditingController();
    final paying = mode == 'approve' && claim['status'] == 'hr_verified';
    // The Dean signs off as Vote Controller against one of the faculty's votes.
    final signing = mode == 'approve' && claim['status'] == 'hod_approved';
    final label = mode == 'reject' ? 'Return for correction' : claim['next_action'] as String;
    List<Map> votes = const [];
    if (signing) {
      try {
        votes = ((await context.read<AppState>().api.get('/api/claims/votes?faculty_id=${claim['faculty_id']}&active=1')) as List).cast<Map>();
      } catch (e) {
        if (mounted) showError(context, e);
        return;
      }
      if (!mounted) return;
    }
    int? voteId = votes.length == 1 ? votes.first['id'] as int : null;
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (dialog, setLocal) => AlertDialog(
        title: Text(label),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('${claim['lecturer_name']}: ${money(claim['total'] as num?, claim['currency'] as String?)}'),
            const SizedBox(height: 12),
            if (signing && votes.isEmpty)
              const Text('There are no votes for this faculty yet. Create one on the web under Pay claims, Votes & budgets, then sign off.'),
            if (signing && votes.isNotEmpty)
              DropdownButtonFormField<int>(
                initialValue: voteId,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Charge to vote *'),
                items: [
                  for (final v in votes)
                    DropdownMenuItem(
                      value: v['id'] as int,
                      child: Text('${v['code']} · balance ${money(v['balance'] as num?, claim['currency'] as String?)}', overflow: TextOverflow.ellipsis),
                    ),
                ],
                onChanged: (v) => setLocal(() => voteId = v),
              ),
            if (paying)
              TextField(
                controller: reference,
                decoration: const InputDecoration(labelText: 'Payment reference *', helperText: 'Voucher, payroll or transfer number'),
              ),
            TextField(
              controller: note,
              maxLines: 3,
              decoration: InputDecoration(labelText: mode == 'reject' ? 'What needs correcting? *' : 'Note (optional)'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: signing && voteId == null ? null : () => Navigator.of(dialog).pop(true), child: Text(label)),
        ],
      ),
      ),
    );
    if (ok != true || !mounted) return;
    final api = context.read<AppState>().api;
    await _run(
      () async => api.post('/api/claims/${claim['id']}/$mode', {'note': note.text, 'payment_reference': reference.text, 'vote_id': ?voteId}),
      mode == 'reject' ? 'Claim returned to the lecturer' : (paying ? 'Payment recorded' : claim['status'] == 'dean_approved' ? 'Approved for payment' : 'Claim signed off'),
    );
  }

  Future<void> _addTask(Map claim) async {
    final api = context.read<AppState>().api;
    final rates = ((await api.get('/api/claims/rates?faculty_id=${claim['faculty_id']}&active=1')) as List)
        .cast<Map>()
        .where((r) => r['kind'] == 'task')
        .toList();
    if (!mounted) return;
    if (rates.isEmpty) return showMessage(context, "Your Dean hasn't set any task rates yet", error: true);
    Map rate = rates.first;
    final qty = TextEditingController(text: '1');
    final details = TextEditingController();
    DateTime date = DateTime.parse(claim['period_end'] as String);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          title: const Text('Add a task'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<Map>(
                  initialValue: rate,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Task'),
                  items: [
                    for (final r in rates)
                      DropdownMenuItem(
                        value: r,
                        child: Text('${r['name']}${r['program_level'] != null ? ' (${r['program_level']})' : ''} · ${money(r['amount'] as num?, claim['currency'] as String?)}/${r['unit']}', overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: (r) => setLocal(() => rate = r ?? rate),
                ),
                TextField(
                  controller: qty,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(labelText: 'Number of ${rate['unit']}s'),
                ),
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Date'),
                  subtitle: Text(niceDate(isoDate(date))),
                  trailing: const Icon(Icons.edit_calendar_outlined),
                  onTap: () async {
                    final picked = await showDatePicker(
                      context: context,
                      initialDate: date,
                      firstDate: DateTime.parse(claim['period_start'] as String),
                      lastDate: DateTime.parse(claim['period_end'] as String),
                    );
                    if (picked != null) setLocal(() => date = picked);
                  },
                ),
                TextField(
                  controller: details,
                  maxLines: 2,
                  decoration: const InputDecoration(labelText: 'Details *', hintText: 'e.g. CSC1103 test 1, 52 scripts'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialog).pop(false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(dialog).pop(true), child: const Text('Add')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    await _run(
      () async => api.post('/api/claims/${claim['id']}/lines', {
        'rate_id': rate['id'],
        'quantity': double.tryParse(qty.text) ?? 0,
        'work_date': isoDate(date),
        'description': details.text,
      }),
      'Task added',
    );
  }

  void _showAttendance(Map claim, Map line) {
    final api = context.read<AppState>().api;
    showModalBottomSheet(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        builder: (context, scroll) => FutureBuilder(
          future: api.get('/api/claims/${claim['id']}/lines/${line['id']}/attendance'),
          builder: (context, snap) {
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            final registers = (snap.data['registers'] as List).cast<Map>();
            return ListView(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
              children: [
                Text(
                  '${line['course_unit_code']} · ${niceDate(line['work_date'])} ${line['start_time']}-${line['end_time']}',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                for (final r in registers) ...[
                  const SizedBox(height: 14),
                  Text(
                    '${r['class_name']} · ${(r['students'] as List).where((s) => s['present'] == 1).length} of ${(r['students'] as List).length} present',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final s in (r['students'] as List).cast<Map>())
                        Chip(
                          visualDensity: VisualDensity.compact,
                          label: Text('${s['name']}${s['present'] == 1 ? '' : ' (absent)'}', style: const TextStyle(fontSize: 12)),
                          backgroundColor: s['present'] == 1 ? Colors.green.withValues(alpha: 0.12) : null,
                        ),
                    ],
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Pay claim'),
        actions: [
          IconButton(
            tooltip: 'Requisition form (PDF)',
            icon: const Icon(Icons.receipt_long_outlined),
            onPressed: () async {
              try {
                await app.openExport('/api/claims/${widget.id}/requisition');
              } catch (e) {
                if (context.mounted) showError(context, e);
              }
            },
          ),
        ],
      ),
      body: AsyncView<Map>(
        key: ValueKey(_version),
        load: () async => await app.api.get('/api/claims/${widget.id}') as Map,
        builder: (context, c, reload) {
          final lines = (c['lines'] as List).cast<Map>();
          final teaching = lines.where((l) => l['kind'] == 'teaching').toList();
          final tasks = lines.where((l) => l['kind'] == 'task').toList();
          final events = (c['events'] as List).cast<Map>();
          final currency = c['currency'] as String?;
          final canEdit = c['can_edit'] == true;
          final canAct = c['can_act'] == true;
          final returned = events.lastWhere((e) => e['action'] == 'returned', orElse: () => {});
          final Widget? actionBar = (canEdit || canAct)
              ? SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                    child: Row(
                      children: [
                        if (canAct) ...[
                          Expanded(
                            child: OutlinedButton(onPressed: _busy ? null : () => _decide(c, 'reject'), child: const Text('Return')),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: FilledButton(onPressed: _busy ? null : () => _decide(c, 'approve'), child: Text('${c['next_action']}')),
                          ),
                        ],
                        if (canEdit) ...[
                          if (c['status'] == 'draft')
                            IconButton(
                              tooltip: 'Delete draft',
                              icon: const Icon(Icons.delete_outline),
                              onPressed: () async {
                                final ok = await confirmDialog(
                                  context,
                                  title: 'Delete this draft?',
                                  message: 'Its lectures become available for another claim.',
                                  danger: true,
                                );
                                if (!ok) return;
                                await app.api.delete('/api/claims/${c['id']}');
                                if (context.mounted) Navigator.of(context).pop();
                              },
                            ),
                          Expanded(
                            child: FilledButton.icon(
                              onPressed: _busy ? null : () => _run(() async => app.api.post('/api/claims/${c['id']}/submit'), 'Claim submitted to your HoD'),
                              icon: const Icon(Icons.send),
                              label: Text(c['status'] == 'rejected' ? 'Resubmit' : 'Submit claim'),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                )
              : null;
          return Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text('${c['title']}', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            '${c['lecturer_title'] ?? ''} ${c['lecturer_name']}'.trim(),
                            style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ),
                        ClaimStatusChip(c),
                      ],
                    ),
                    Text(
                      '${c['department_name'] ?? ''} · ${niceDate(c['period_start'])} to ${niceDate(c['period_end'])}',
                      style: TextStyle(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 12),
                    if (c['status'] == 'rejected' && returned.isNotEmpty)
                      Card(
                        color: scheme.errorContainer,
                        child: ListTile(
                          leading: Icon(Icons.undo, color: scheme.onErrorContainer),
                          title: Text(
                            'Returned by the ${returned['stage']}',
                            style: TextStyle(color: scheme.onErrorContainer, fontWeight: FontWeight.w600),
                          ),
                          subtitle: Text('${returned['note']}', style: TextStyle(color: scheme.onErrorContainer)),
                        ),
                      ),
                    if (canEdit && (c['pending_lectures'] ?? 0) > 0)
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.pending_actions),
                          title: Text('${_plural(c['pending_lectures'] as num, 'lecture')} still need your attendance approval'),
                          subtitle: const Text('Approve the registers, then refresh this claim.'),
                        ),
                      ),
                    if (c['status'] == 'paid')
                      Card(
                        child: ListTile(
                          leading: Icon(Icons.check_circle, color: Colors.green.shade700),
                          title: const Text('Paid'),
                          subtitle: Text('Payment reference ${c['payment_reference']}'),
                        ),
                      ),
                    StatGrid(
                      children: [
                        StatTile(label: 'Teaching hours', value: _qty(c['teaching_hours'] as num)),
                        StatTile(label: 'Total claimed', value: money(c['total'] as num?, currency), color: scheme.primary),
                      ],
                    ),
                    const SizedBox(height: 12),
                    SectionCard(
                      title: 'Lectures taught',
                      trailing: canEdit
                          ? IconButton(
                              tooltip: 'Update from attendance',
                              icon: const Icon(Icons.refresh),
                              onPressed: () => _run(() async => app.api.post('/api/claims/${c['id']}/refresh'), 'Lectures updated'),
                            )
                          : null,
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                      child: teaching.isEmpty
                          ? Text('No attendance-approved lectures in this period.', style: TextStyle(color: scheme.onSurfaceVariant))
                          : Column(
                              children: [
                                for (final l in teaching)
                                  ListTile(
                                    contentPadding: EdgeInsets.zero,
                                    onTap: () => _showAttendance(c, l),
                                    title: Text('${l['course_unit_code']} · ${niceDate(l['work_date'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
                                    subtitle: Text(
                                      '${l['start_time']}-${l['end_time']} · ${l['class_names']}\n${l['students_present']} of ${l['students_total']} students attended',
                                    ),
                                    isThreeLine: true,
                                    trailing: Column(
                                      mainAxisAlignment: MainAxisAlignment.center,
                                      crossAxisAlignment: CrossAxisAlignment.end,
                                      children: [
                                        Text(money(l['amount'] as num?, currency), style: const TextStyle(fontWeight: FontWeight.w600)),
                                        Text('${_qty(l['quantity'] as num)} h', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12)),
                                      ],
                                    ),
                                  ),
                              ],
                            ),
                    ),
                    SectionCard(
                      title: 'Tasks',
                      trailing: canEdit ? TextButton.icon(onPressed: () => _addTask(c), icon: const Icon(Icons.add), label: const Text('Add')) : null,
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                      child: tasks.isEmpty
                          ? Text(canEdit ? 'Add marking, supervision or other tasks.' : 'No tasks claimed.', style: TextStyle(color: scheme.onSurfaceVariant))
                          : Column(
                              children: [
                                for (final l in tasks)
                                  ListTile(
                                    contentPadding: EdgeInsets.zero,
                                    title: Text(
                                      '${l['rate_name']} · ${_qty(l['quantity'] as num)} ${l['unit']}${l['quantity'] == 1 ? '' : 's'}',
                                      style: const TextStyle(fontWeight: FontWeight.w600),
                                    ),
                                    subtitle: Text('${niceDate(l['work_date'])} · ${l['description'] ?? ''}'),
                                    trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Text(money(l['amount'] as num?, currency), style: const TextStyle(fontWeight: FontWeight.w600)),
                                        if (canEdit)
                                          IconButton(
                                            icon: const Icon(Icons.delete_outline),
                                            onPressed: () => _run(() async => app.api.delete('/api/claims/${c['id']}/lines/${l['id']}'), 'Task removed'),
                                          ),
                                      ],
                                    ),
                                  ),
                              ],
                            ),
                    ),
                    SectionCard(
                      title: 'History',
                      child: Column(
                        children: [
                          for (final e in events)
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              leading: Icon(switch (e['action']) {
                                'returned' => Icons.undo,
                                'paid' => Icons.payments_outlined,
                                'created' => Icons.edit_note,
                                _ => Icons.check_circle_outline,
                              }, color: e['action'] == 'returned' ? scheme.error : scheme.primary),
                              title: Text(
                                '${_eventLabel(e['action'] as String)}${e['stage'] != null && e['action'] != 'paid' ? ' · ${e['stage']}' : ''} · ${e['actor_name'] ?? ''}',
                              ),
                              subtitle: Text([if (e['note'] != null) '${e['note']}', _localTime(e['created_at'] as String)].join('\n')),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              ?actionBar,
            ],
          );
        },
      ),
    );
  }
}

/// Server times are UTC (`2026-10-18 20:30:00`); show them in the phone's time zone.
String _localTime(String utc) => DateFormat('d MMM yyyy, HH:mm').format(DateTime.parse('${utc.replaceFirst(' ', 'T')}Z').toLocal());

String _eventLabel(String action) => switch (action) {
  'created' => 'Draft created',
  'submitted' => 'Submitted',
  'resubmitted' => 'Resubmitted',
  'approved' => 'Approved',
  'verified' => 'Verified by HR',
  'paid' => 'Payment recorded',
  'returned' => 'Returned',
  _ => action,
};
