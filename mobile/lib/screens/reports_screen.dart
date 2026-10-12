import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// Scoped reports: Admin = university, Dean = faculty, HoD = department, lecturer = own teaching.
class ReportsScreen extends StatelessWidget {
  const ReportsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Reports'),
        actions: [
          IconButton(
            tooltip: 'Export Excel',
            icon: const Icon(Icons.table_view_outlined),
            onPressed: () async {
              try {
                await app.openExport('/api/reports/export');
              } catch (e) {
                if (context.mounted) showError(context, e);
              }
            },
          ),
        ],
      ),
      body: AsyncView<Map<String, dynamic>>(
        load: () async => await app.api.get('/api/reports/overview') as Map<String, dynamic>,
        builder: (context, r, reload) {
          final c = r['counts'] as Map<String, dynamic>;
          final att = r['attendance'] as Map<String, dynamic>;
          final scheme = Theme.of(context).colorScheme;
          return ListView(padding: const EdgeInsets.all(12), children: [
            Text('Scope: ${r['scope']}', style: const TextStyle(fontWeight: FontWeight.w600)),
            Text(r['term']?['name'] ?? 'No term', style: TextStyle(color: scheme.onSurfaceVariant)),
            const SizedBox(height: 12),
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
            if ((r['departments'] as List).length > 1)
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
            SectionCard(
              title: 'Lecturer workload',
              child: Column(children: [
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
            SectionCard(
              title: 'Attendance by course unit',
              child: Column(children: [
                for (final cu in att['by_course'])
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Row(children: [Flexible(child: Text('${cu['code']} ${cu['name']}', overflow: TextOverflow.ellipsis)), if (cu['is_cross_cutting'] == 1) const CcBadge()]),
                    subtitle: Text('${cu['classes']} · ${cu['registers']} lectures'),
                    trailing: Text(rateText(cu['rate'] as num?), style: TextStyle(fontWeight: FontWeight.w700, color: rateColor(context, cu['rate'] as num?))),
                  ),
              ]),
            ),
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
            if ((r['rooms'] as List).isNotEmpty)
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
