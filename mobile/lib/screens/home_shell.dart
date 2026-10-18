import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'attendance_screen.dart';
import 'claims_screen.dart';
import 'dashboard_screen.dart';
import 'more_screen.dart';
import 'notifications_screen.dart';
import 'platform_screen.dart';
import 'timetable_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  late final AppState _app;

  @override
  void initState() {
    super.initState();
    _app = context.read<AppState>();
    _app.incoming.addListener(_onIncoming);
    // Ask once for notification permission and schedule lecture reminders.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _app.syncReminders();
    });
  }

  @override
  void dispose() {
    _app.incoming.removeListener(_onIncoming);
    super.dispose();
  }

  void _onIncoming() {
    final n = _app.incoming.value;
    if (n == null || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      behavior: SnackBarBehavior.floating,
      duration: const Duration(seconds: 6),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(n['title'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
        if (n['body'] != null) Text(n['body'] as String),
      ]),
      action: SnackBarAction(label: 'View', onPressed: () => setState(() => _index = _app.isHr ? 2 : 3)),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    if (app.isSuperAdmin) return const PlatformScreen();
    if (app.isHr) return _hrShell(app);

    final pages = <Widget>[
      DashboardScreen(onNavigate: (i) => setState(() => _index = i)),
      const TimetableScreen(),
      const AttendanceScreen(),
      const NotificationsScreen(),
      const MoreScreen(),
    ];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          const NavigationDestination(icon: Icon(Icons.calendar_month_outlined), selectedIcon: Icon(Icons.calendar_month), label: 'Timetable'),
          const NavigationDestination(icon: Icon(Icons.fact_check_outlined), selectedIcon: Icon(Icons.fact_check), label: 'Attendance'),
          NavigationDestination(
            icon: Badge(isLabelVisible: app.unread > 0, label: Text('${app.unread}'), child: const Icon(Icons.notifications_outlined)),
            selectedIcon: const Icon(Icons.notifications),
            label: 'Alerts',
          ),
          const NavigationDestination(icon: Icon(Icons.menu), label: 'More'),
        ],
      ),
    );
  }

  /// HR (Directorate) only handles pay claims, so it gets a shorter menu.
  Widget _hrShell(AppState app) {
    final pages = <Widget>[
      DashboardScreen(onNavigate: (i) => setState(() => _index = i)),
      const ClaimsScreen(asTab: true),
      const NotificationsScreen(),
      const MoreScreen(),
    ];
    final index = _index.clamp(0, pages.length - 1);
    return Scaffold(
      body: IndexedStack(index: index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.dashboard_outlined), selectedIcon: Icon(Icons.dashboard), label: 'Home'),
          const NavigationDestination(icon: Icon(Icons.account_balance_wallet_outlined), selectedIcon: Icon(Icons.account_balance_wallet), label: 'Claims'),
          NavigationDestination(
            icon: Badge(isLabelVisible: app.unread > 0, label: Text('${app.unread}'), child: const Icon(Icons.notifications_outlined)),
            selectedIcon: const Icon(Icons.notifications),
            label: 'Alerts',
          ),
          const NavigationDestination(icon: Icon(Icons.menu), label: 'More'),
        ],
      ),
    );
  }
}

/// App bar title with the university logo, used by the main tabs.
class BrandTitle extends StatelessWidget {
  const BrandTitle(this.title, {super.key});
  final String title;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return Row(children: [
      const UniversityLogo(size: 32),
      const SizedBox(width: 10),
      Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
          Text(app.university?['name'] as String? ?? '', style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant), overflow: TextOverflow.ellipsis),
        ]),
      ),
    ]);
  }
}
