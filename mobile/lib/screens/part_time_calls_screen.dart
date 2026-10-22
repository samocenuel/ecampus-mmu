import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// Internal part-time calls: units offered to full-time staff as paid part-time load.
/// Lecturers respond; the HoD (or Dean / administrator) assigns one of them.
class PartTimeCallsScreen extends StatefulWidget {
  const PartTimeCallsScreen({super.key});

  @override
  State<PartTimeCallsScreen> createState() => _PartTimeCallsScreenState();
}

class _PartTimeCallsScreenState extends State<PartTimeCallsScreen> {
  int _version = 0;

  Future<void> _run(Future<dynamic> Function() call, String done) async {
    try {
      await call();
      if (mounted) showMessage(context, done);
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _respond(Map c) async {
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Offer to teach ${c['code']}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('The hours are paid as internal part-time load through Pay claims once attendance is approved.'),
          const SizedBox(height: 10),
          TextField(controller: note, maxLines: 2, decoration: const InputDecoration(labelText: 'Note for the HoD (optional)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Send')),
        ],
      ),
    );
    if (ok == true && mounted) {
      await _run(() => context.read<AppState>().api.post('/api/allocations/part-time-calls/${c['id']}/respond', {'note': note.text}), 'Thank you, your HoD will be in touch');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    final manager = app.isManager;
    return Scaffold(
      appBar: AppBar(title: const Text('Part-time calls')),
      body: AsyncView<List>(
        key: ValueKey(_version),
        load: () async => await app.api.get('/api/allocations/part-time-calls') as List,
        builder: (context, list, reload) {
          if (list.isEmpty) return ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.campaign_outlined, title: 'No calls this term')]);
          return ListView(padding: const EdgeInsets.all(12), children: [
            for (final c in list.cast<Map>())
              SectionCard(
                title: '${c['code']} ${c['course_name']}',
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Text('${(c['classes'] as List).map((x) => x['name']).join(', ')} · ${c['hours_per_week']} h a week'),
                  Text(
                    c['status'] == 'open' ? 'Open' : c['status'] == 'filled' ? 'Assigned to ${c['filled_by_name'] ?? ''}' : 'Closed',
                    style: TextStyle(fontWeight: FontWeight.w600, color: c['status'] == 'open' ? Colors.orange.shade800 : null),
                  ),
                  if (c['note'] != null) Text('${c['note']}'),
                  if (!manager && c['status'] == 'open' && !app.isPartTimerByContract)
                    Align(
                      alignment: Alignment.centerRight,
                      child: c['responded'] == true
                          ? TextButton(onPressed: () => _run(() => app.api.delete('/api/allocations/part-time-calls/${c['id']}/respond'), 'Response withdrawn'), child: const Text('Withdraw'))
                          : FilledButton.icon(onPressed: () => _respond(c), icon: const Icon(Icons.pan_tool_outlined), label: const Text('I can take it')),
                    ),
                  if (manager && c['can_manage'] == true) ...[
                    const SizedBox(height: 6),
                    Text((c['responses'] as List).isEmpty ? 'No responses yet' : 'Responses', style: Theme.of(context).textTheme.labelLarge),
                    for (final r in (c['responses'] as List).cast<Map>())
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text([r['title'], r['name']].whereType<String>().join(' ')),
                        subtitle: Text([
                          if (r['department_name'] != null) '${r['department_name']}',
                          if (r['workload'] != null) 'Load ${r['workload']['hours']}/${r['workload']['max']} h',
                          if (r['note'] != null) '${r['note']}',
                        ].join(' · ')),
                        trailing: c['status'] == 'open'
                            ? FilledButton(
                                onPressed: () => _run(() => app.api.post('/api/allocations/part-time-calls/${c['id']}/assign', {'user_id': r['user_id']}), '${c['code']} allocated to ${r['name']}'),
                                child: const Text('Assign'),
                              )
                            : null,
                      ),
                    if (c['status'] == 'open')
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(onPressed: () => _run(() => app.api.post('/api/allocations/part-time-calls/${c['id']}/close'), 'Call closed'), child: const Text('Close call')),
                      ),
                  ],
                ]),
              ),
          ]);
        },
      ),
    );
  }
}
