import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'manage/allocation_screen.dart';
import 'manage/resource_screen.dart';
import 'manage/specs.dart';
import 'manage/university_screen.dart';
import 'claims_screen.dart';
import 'profile_screen.dart';
import 'reports_screen.dart';

class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final user = app.user!;
    final scheme = Theme.of(context).colorScheme;
    void open(Widget page) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));
    Widget tile(IconData icon, String label, VoidCallback onTap, {String? subtitle}) =>
        ListTile(leading: Icon(icon), title: Text(label), subtitle: subtitle != null ? Text(subtitle) : null, trailing: const Icon(Icons.chevron_right), onTap: onTap);
    Widget header(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Text(text.toUpperCase(), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: scheme.onSurfaceVariant, letterSpacing: 0.6)),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: ListView(children: [
        Card(
          margin: const EdgeInsets.all(12),
          child: ListTile(
            contentPadding: const EdgeInsets.all(12),
            leading: CircleAvatar(radius: 26, backgroundColor: scheme.primaryContainer, child: Text((user['name'] as String).substring(0, 1), style: TextStyle(fontSize: 22, color: scheme.onPrimaryContainer))),
            title: Text('${user['title'] ?? ''} ${user['name']}'.trim(), style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text([
              [roleLabels[user['role']], if (app.isPartTimer) 'Part-time'].whereType<String>().join(' · '),
              if (app.isClassRep) 'Class rep · ${(user['rep_classes'] as List).map((c) => c['name']).join(', ')}',
              user['department_name'] ?? user['class_name'] ?? user['faculty_name'],
            ].whereType<String>().join('\n')),
            onTap: () => open(const ProfileScreen()),
          ),
        ),
        if (app.isStaff) ...[
          header('Teaching'),
          tile(Icons.insights_outlined, 'Reports', () => open(const ReportsScreen()), subtitle: app.isManager ? 'Your unit' : 'Your teaching'),
          if (app.isManager) tile(Icons.assignment_ind_outlined, 'Load allocation', () => open(const AllocationScreen()), subtitle: 'Cross-cutting units first'),
        ],
        if (app.isPartTimer || app.approvesClaims) ...[
          header('Part-time pay'),
          if (!app.isHr) tile(Icons.account_balance_wallet_outlined, 'Pay claims', () => open(const ClaimsScreen()), subtitle: app.isPartTimer ? 'Claim teaching hours and tasks' : 'Approve part-time claims'),
          tile(Icons.price_change_outlined, 'Pay rates', () => open(ResourceScreen(spec: payRatesSpec)), subtitle: app.isAdmin || app.role == 'dean' ? 'Set the rate per hour and per task' : 'Rates for your faculty'),
        ],
        if (app.isManager) ...[
          header('Setup'),
          if (app.isAdmin) tile(Icons.account_balance_outlined, 'University profile', () => open(const UniversityScreen()), subtitle: 'Logo, contacts, theme colour'),
          // A Dean oversees the departments of one faculty; a HoD runs a single department, so neither needs these lists.
          if (app.isAdmin) tile(Icons.domain_outlined, 'Faculties', () => open(ResourceScreen(spec: facultiesSpec))),
          if (app.isAdmin || app.role == 'dean') tile(Icons.account_tree_outlined, 'Departments', () => open(ResourceScreen(spec: departmentsSpec))),
          tile(Icons.school_outlined, 'Programmes', () => open(ResourceScreen(spec: programmesSpec))),
          tile(Icons.menu_book_outlined, 'Course units', () => open(ResourceScreen(spec: courseUnitsSpec))),
          tile(Icons.groups_outlined, 'Classes & class reps', () => open(ResourceScreen(spec: classesSpec(context)))),
          if (app.isAdmin) tile(Icons.meeting_room_outlined, 'Rooms', () => open(ResourceScreen(spec: roomsSpec))),
          if (app.isAdmin) tile(Icons.date_range_outlined, 'Academic terms', () => open(ResourceScreen(spec: termsSpec))),
          tile(Icons.badge_outlined, app.isAdmin ? 'Lecturers, HoDs & Deans' : app.role == 'dean' ? 'Faculty staff' : 'Department staff', () => open(ResourceScreen(spec: usersSpec(app, 'staff')))),
          tile(Icons.person_search_outlined, 'Students', () => open(ResourceScreen(spec: usersSpec(app, 'students')))),
          if (app.isAdmin) tile(Icons.admin_panel_settings_outlined, 'Administrators', () => open(ResourceScreen(spec: usersSpec(app, 'admins')))),
        ],
        header('Account'),
        tile(Icons.lock_outline, 'Profile & password', () => open(const ProfileScreen())),
        ListTile(
          leading: const Icon(Icons.privacy_tip_outlined),
          title: const Text('Privacy policy'),
          trailing: const Icon(Icons.open_in_new, size: 18),
          onTap: () => launchUrl(Uri.parse('${app.api.baseUrl}/privacy'), mode: LaunchMode.externalApplication),
        ),
        ListTile(
          leading: Icon(Icons.logout, color: scheme.error),
          title: Text('Sign out', style: TextStyle(color: scheme.error)),
          onTap: () async {
            if (await confirmDialog(context, title: 'Sign out?', message: 'Scheduled lecture reminders stay on this phone until you sign in again.')) {
              await app.logout();
            }
          },
        ),
        const SizedBox(height: 24),
      ]),
    );
  }
}
