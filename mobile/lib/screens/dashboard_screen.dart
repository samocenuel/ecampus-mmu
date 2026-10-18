import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'claims_screen.dart';
import 'home_shell.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key, required this.onNavigate});

  /// Switches the bottom-navigation tab (1 = timetable, 2 = attendance, 3 = alerts).
  final ValueChanged<int> onNavigate;

  String _greeting() {
    final h = DateTime.now().hour;
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final user = app.user!;
    return Scaffold(
      appBar: AppBar(title: const BrandTitle('Home')),
      body: AsyncView<Map<String, dynamic>>(
        load: () async => await app.api.get('/api/dashboard') as Map<String, dynamic>,
        builder: (context, d, reload) {
          final scheme = Theme.of(context).colorScheme;
          final counts = d['counts'] as Map<String, dynamic>?;
          final allocation = d['allocation'] as Map<String, dynamic>?;
          final attendance = d['attendance'] as Map<String, dynamic>?;
          final today = (d['today_sessions'] as List).cast<Map<String, dynamic>>();
          final upcoming = (d['upcoming'] as List).cast<Map<String, dynamic>>();
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('${_greeting()}, ${(user['name'] as String).split(' ').first}', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(
              '${d['day_name']} · ${d['term']?['name'] ?? 'No term'} · ${d['scope']}',
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            if ((d['claims']?['awaiting_me'] ?? 0) > 0)
              _ActionBanner(
                icon: Icons.account_balance_wallet_outlined,
                text: '${d['claims']['awaiting_me']} pay ${d['claims']['awaiting_me'] == 1 ? 'claim is' : 'claims are'} waiting for you (${money(d['claims']['awaiting_me_total'] as num?, d['claims']['currency'] as String?)}).',
                action: 'Open',
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ClaimsScreen())),
              ),
            if ((d['claims']?['mine']?['returned'] ?? 0) > 0)
              _ActionBanner(
                icon: Icons.undo,
                text: 'A pay claim was returned to you for correction.',
                action: 'Fix',
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ClaimsScreen())),
              ),
            if (app.isClassRep && (d['registers_due_today'] ?? 0) > 0)
              _ActionBanner(
                icon: Icons.how_to_reg,
                text: 'You have ${d['registers_due_today']} attendance ${d['registers_due_today'] == 1 ? 'register' : 'registers'} to take today.',
                action: 'Take attendance',
                onTap: () => onNavigate(2),
              ),
            if (app.teaches && (d['my_pending_approvals'] ?? 0) > 0)
              _ActionBanner(
                icon: Icons.pending_actions,
                text: '${d['my_pending_approvals']} attendance ${d['my_pending_approvals'] == 1 ? 'register' : 'registers'} waiting for your approval.',
                action: 'Review',
                onTap: () => onNavigate(2),
              ),
            if (app.isManager && counts != null) ...[
              StatGrid(children: [
                StatTile(label: 'Programmes', value: '${counts['programs']}', icon: Icons.school_outlined),
                StatTile(label: 'Course units', value: '${counts['course_units'] ?? '-'}', icon: Icons.menu_book_outlined),
                StatTile(label: 'Lecturers', value: '${counts['lecturers']}', icon: Icons.person_outline),
                StatTile(label: 'Students', value: '${counts['students']}', icon: Icons.groups_outlined),
              ]),
              const SizedBox(height: 12),
            ],
            if (today.isNotEmpty || app.teaches || app.isStudent)
              SectionCard(
                title: "Today's lectures",
                trailing: TextButton(onPressed: () => onNavigate(1), child: const Text('Timetable')),
                child: today.isEmpty
                    ? Padding(padding: const EdgeInsets.all(8), child: Text('No lectures today.', style: TextStyle(color: scheme.onSurfaceVariant)))
                    : Column(children: [for (final s in today) SessionTile(session: s, showClasses: !app.isStudent)]),
              ),
            if (app.isStudent && attendance != null)
              SectionCard(
                title: 'My attendance',
                trailing: TextButton(onPressed: () => onNavigate(2), child: const Text('History')),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(rateText(attendance['rate'] as num?), style: TextStyle(fontSize: 40, fontWeight: FontWeight.w700, color: rateColor(context, attendance['rate'] as num?))),
                  Text('${attendance['attended']} of ${attendance['total']} approved lectures attended', style: TextStyle(color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 8),
                  LinearProgressIndicator(
                    value: (attendance['total'] as num) > 0 ? (attendance['attended'] as num) / (attendance['total'] as num) : 0,
                    minHeight: 8,
                    borderRadius: BorderRadius.circular(8),
                    color: rateColor(context, attendance['rate'] as num?),
                  ),
                ]),
              ),
            if (app.isManager && allocation != null)
              SectionCard(
                title: 'Load allocation',
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  _progress(context, 'Cross-cutting units (allocate first)', allocation['cross_cutting_allocated'], allocation['cross_cutting_pairs'], Colors.orange.shade700),
                  const SizedBox(height: 10),
                  _progress(context, 'Programme-specific units', allocation['other_allocated'], allocation['other_pairs'], scheme.primary),
                  const SizedBox(height: 8),
                  Text('${counts?['weekly_sessions']} weekly sessions · ${counts?['weekly_teaching_hours']} hrs', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12.5)),
                ]),
              ),
            if ((app.isManager || app.role == 'lecturer') && attendance != null)
              SectionCard(
                title: 'Attendance',
                child: StatGrid(children: [
                  StatTile(label: 'Average attendance', value: rateText(attendance['average_rate'] as num?), color: rateColor(context, attendance['average_rate'] as num?)),
                  StatTile(label: 'Awaiting approval', value: '${attendance['pending_registers']}'),
                  StatTile(label: 'Students below 75%', value: '${attendance['at_risk']}', color: (attendance['at_risk'] ?? 0) > 0 ? scheme.error : null),
                ]),
              ),
            if (app.teaches)
              SectionCard(
                title: 'My teaching load',
                child: StatGrid(children: [
                  StatTile(label: 'Hours per week', value: '${d['my_weekly_hours']}', icon: Icons.schedule),
                  StatTile(label: 'Registers to approve', value: '${d['my_pending_approvals']}', icon: Icons.fact_check_outlined),
                ]),
              ),
            if (upcoming.isNotEmpty)
              SectionCard(
                title: 'Coming up this week',
                child: Column(children: [
                  for (final u in upcoming)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(
                        backgroundColor: scheme.primaryContainer,
                        child: Text(dayShort[DateTime.parse(u['date']).weekday], style: TextStyle(fontSize: 12, color: scheme.onPrimaryContainer, fontWeight: FontWeight.w700)),
                      ),
                      title: Text('${u['course_code']} ${u['course_name']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text('${u['start_time']}-${u['end_time']} · ${u['room_name']}'),
                      trailing: u['in_progress'] == true ? const Chip(label: Text('Now')) : null,
                    ),
                ]),
              ),
          ]);
        },
      ),
    );
  }

  Widget _progress(BuildContext context, String label, dynamic done, dynamic total, Color color) {
    final d = (done as num?) ?? 0;
    final t = (total as num?) ?? 0;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Expanded(child: Text(label)), Text('$d/$t', style: const TextStyle(fontWeight: FontWeight.w700))]),
      const SizedBox(height: 6),
      LinearProgressIndicator(value: t > 0 ? d / t : 0, minHeight: 8, color: color, borderRadius: BorderRadius.circular(8)),
    ]);
  }
}

class _ActionBanner extends StatelessWidget {
  const _ActionBanner({required this.icon, required this.text, required this.action, required this.onTap});
  final IconData icon;
  final String text;
  final String action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      color: scheme.primaryContainer,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(children: [
          Icon(icon, color: scheme.onPrimaryContainer),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: TextStyle(color: scheme.onPrimaryContainer))),
          FilledButton(onPressed: onTap, child: Text(action)),
        ]),
      ),
    );
  }
}
