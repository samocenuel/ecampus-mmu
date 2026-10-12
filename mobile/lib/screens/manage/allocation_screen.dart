import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/app_state.dart';
import '../../widgets/common.dart';

/// Load allocation: Step 1 cross-cutting units, Step 2 programme-specific units.
class AllocationScreen extends StatefulWidget {
  const AllocationScreen({super.key});

  @override
  State<AllocationScreen> createState() => _AllocationScreenState();
}

class _AllocationScreenState extends State<AllocationScreen> {
  int _version = 0;

  Future<void> _allocate(Map unit) async {
    final app = context.read<AppState>();
    final lecturers = await app.api.get('/api/users?roles=lecturer,hod,dean&active=1') as List;
    if (!mounted) return;
    final pending = (unit['classes'] as List).where((c) => c['allocation_id'] == null).toList();
    final selected = {for (final c in pending) c['class_id'] as int};
    String? lecturerId;
    var hours = (unit['hours_per_week'] as num).toInt();

    final go = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => Padding(
          padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.of(ctx).viewInsets.bottom + 20),
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Row(children: [
                Expanded(child: Text('Allocate ${unit['code']}', style: Theme.of(ctx).textTheme.titleLarge)),
                if (unit['is_cross_cutting'] == 1) const CcBadge(),
              ]),
              Text('${unit['name']}', style: TextStyle(color: Theme.of(ctx).colorScheme.onSurfaceVariant)),
              const SizedBox(height: 16),
              DropdownButtonFormField<String>(
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Lecturer *'),
                items: [
                  for (final l in lecturers)
                    DropdownMenuItem(value: '${l['id']}', child: Text('${l['title'] ?? ''} ${l['name']} · ${l['department_name'] ?? '-'}'.trim(), overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => setLocal(() => lecturerId = v),
              ),
              const SizedBox(height: 12),
              TextFormField(
                initialValue: '$hours',
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Hours per week'),
                onChanged: (v) => hours = int.tryParse(v) ?? hours,
              ),
              const SizedBox(height: 12),
              Text(unit['is_cross_cutting'] == 1 ? 'Classes taught together (combine programmes)' : 'Classes', style: const TextStyle(fontWeight: FontWeight.w600)),
              for (final c in pending)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: selected.contains(c['class_id']),
                  title: Text('${c['class_name']} (${c['program_code']})'),
                  onChanged: (v) => setLocal(() => v == true ? selected.add(c['class_id'] as int) : selected.remove(c['class_id'])),
                ),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: lecturerId == null || selected.isEmpty ? null : () => Navigator.pop(ctx, true),
                child: const Text('Allocate'),
              ),
            ]),
          ),
        ),
      ),
    );
    if (go != true || !mounted) return;
    try {
      final res = await runWithConfirm(
        context,
        (force) => app.api.post('/api/allocations', {'course_unit_id': unit['course_unit_id'], 'lecturer_id': lecturerId, 'class_ids': selected.toList(), 'hours_per_week': hours, 'force': force}),
      );
      if (res != null && mounted) {
        showMessage(context, '${unit['code']} allocated to ${res['lecturer_name']}');
        setState(() => _version++);
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = context.read<AppState>().api;
    return Scaffold(
      appBar: AppBar(title: const Text('Load allocation')),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey('alloc-$_version'),
        load: () async => await api.get('/api/allocations/requirements') as Map<String, dynamic>,
        builder: (context, r, reload) {
          final s = r['summary'] as Map<String, dynamic>;
          final ccDone = (s['cross_cutting_allocated'] as num) >= (s['cross_cutting_pairs'] as num);
          final scheme = Theme.of(context).colorScheme;
          return ListView(padding: const EdgeInsets.all(12), children: [
            Text(r['term']?['name'] ?? 'No term', style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (r['cross_cutting_units_defined'] == 0)
              Card(
                color: Colors.orange.shade50,
                child: const ListTile(
                  leading: Icon(Icons.warning_amber, color: Colors.orange),
                  title: Text('No cross-cutting course units yet'),
                  subtitle: Text('Create cross-cutting units (e.g. Communication Skills) first - they are allocated before programme units.'),
                ),
              ),
            _stepCard(context, 1, 'Cross-cutting units', s['cross_cutting_allocated'], s['cross_cutting_pairs'], true),
            _stepCard(context, 2, 'Programme-specific units', s['other_allocated'], s['other_pairs'], ccDone),
            const SizedBox(height: 8),
            Text('STEP 1 · CROSS-CUTTING (ALLOCATE FIRST)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Colors.orange.shade800)),
            const SizedBox(height: 6),
            for (final u in r['cross_cutting']) _unitCard(context, u as Map),
            const SizedBox(height: 12),
            Text('STEP 2 · PROGRAMME-SPECIFIC', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: scheme.primary)),
            if (!ccDone)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text('Cross-cutting units are still pending - you will be asked to confirm before allocating these.', style: TextStyle(color: Colors.orange.shade800, fontSize: 12.5)),
              ),
            const SizedBox(height: 6),
            for (final u in r['program_specific']) _unitCard(context, u as Map),
          ]);
        },
      ),
    );
  }

  Widget _stepCard(BuildContext context, int n, String label, dynamic done, dynamic total, bool active) {
    final d = (done as num).toInt();
    final t = (total as num).toInt();
    final complete = d >= t;
    return Card(
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: complete ? Colors.green.shade600 : active ? Theme.of(context).colorScheme.primary : Colors.grey.shade300,
          child: complete ? const Icon(Icons.check, color: Colors.white) : Text('$n', style: const TextStyle(color: Colors.white)),
        ),
        title: Text(label),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: LinearProgressIndicator(value: t > 0 ? d / t : 0, minHeight: 6, borderRadius: BorderRadius.circular(6), color: n == 1 ? Colors.orange.shade700 : null),
        ),
        trailing: Text('$d/$t', style: const TextStyle(fontWeight: FontWeight.w700)),
      ),
    );
  }

  Widget _unitCard(BuildContext context, Map u) {
    final classes = (u['classes'] as List);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text('${u['code']} · ${u['name']}', style: const TextStyle(fontWeight: FontWeight.w600))),
            if (u['fully_allocated'] == true)
              const StatusChip('approved')
            else
              FilledButton.tonal(onPressed: () => _allocate(u), child: const Text('Allocate')),
          ]),
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final c in classes)
              Chip(
                visualDensity: VisualDensity.compact,
                backgroundColor: c['allocation_id'] != null ? Colors.green.shade50 : Colors.orange.shade50,
                label: Text('${c['class_name']}${c['lecturer_name'] != null ? ' · ${c['lecturer_name']}' : ''}', style: const TextStyle(fontSize: 12)),
              ),
          ]),
        ]),
      ),
    );
  }
}
