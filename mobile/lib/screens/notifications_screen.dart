import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../core/notifications.dart';
import '../widgets/common.dart';
import 'home_shell.dart';

const _leadTimes = [5, 10, 15, 20, 30, 45, 60, 90, 120];

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  int _version = 0;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const BrandTitle('Alerts'),
        actions: [
          IconButton(
            tooltip: 'Mark all read',
            icon: const Icon(Icons.done_all),
            onPressed: () async {
              await app.api.post('/api/notifications/read-all');
              app.markAllRead();
              setState(() => _version++);
            },
          ),
        ],
      ),
      body: AsyncView<List>(
        key: ValueKey('notifs-$_version-${app.unread}'),
        load: () async {
          final res = await Future.wait([app.api.get('/api/notifications?limit=100'), app.api.get('/api/notifications/preferences')]);
          return res;
        },
        builder: (context, data, reload) {
          final items = (data[0]['items'] as List);
          final prefs = data[1] as Map<String, dynamic>;
          return ListView(padding: const EdgeInsets.all(12), children: [
            if (app.isStudent || app.teaches) _ReminderSettings(prefs: prefs, onChanged: reload),
            if (app.isStudent || app.teaches || app.isManager) _ResearchReminderSettings(prefs: prefs, onChanged: reload),
            const SizedBox(height: 4),
            if (items.isEmpty) const EmptyView(icon: Icons.notifications_none, title: 'No notifications yet'),
            for (final n in items)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                color: n['read_at'] == null ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.35) : null,
                child: ListTile(
                  leading: Icon(switch (n['type']) {
                    'reminder' => Icons.alarm,
                    'attendance' => Icons.fact_check_outlined,
                    'allocation' => Icons.assignment_ind_outlined,
                    'timetable' => Icons.calendar_month_outlined,
                    'appointment' => Icons.workspace_premium_outlined,
                    _ => Icons.notifications_outlined,
                  }),
                  title: Text(n['title'] as String, style: TextStyle(fontWeight: n['read_at'] == null ? FontWeight.w700 : FontWeight.w500)),
                  subtitle: Text('${n['body'] ?? ''}\n${DateTime.parse('${(n['created_at'] as String).replaceFirst(' ', 'T')}Z').toLocal().toString().substring(0, 16)}'),
                  isThreeLine: true,
                  onTap: n['read_at'] == null
                      ? () async {
                          await app.api.post('/api/notifications/${n['id']}/read');
                          await reload();
                        }
                      : null,
                ),
              ),
          ]);
        },
      ),
    );
  }
}

class _ReminderSettings extends StatelessWidget {
  const _ReminderSettings({required this.prefs, required this.onChanged});
  final Map<String, dynamic> prefs;
  final Future<void> Function() onChanged;

  Future<void> _save(BuildContext context, Map<String, dynamic> patch) async {
    final app = context.read<AppState>();
    try {
      await app.api.put('/api/notifications/preferences', {...prefs, ...patch});
      final scheduled = await app.syncReminders();
      if (context.mounted) {
        showMessage(context, NotificationService.instance.supported ? 'Saved - $scheduled reminder(s) scheduled on this phone' : 'Reminder settings saved');
      }
      await onChanged();
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = prefs['enabled'] == true;
    final minutes = (prefs['minutes_before'] as num).toInt();
    return SectionCard(
      title: 'Lecture reminders',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Remind me before lectures'),
          subtitle: Text(NotificationService.instance.supported ? 'Phone notifications, even when the app is closed' : 'Shown in the app and on the web'),
          value: enabled,
          onChanged: (v) async {
            if (v) await NotificationService.instance.requestPermission();
            if (context.mounted) await _save(context, {'enabled': v});
          },
        ),
        DropdownButtonFormField<int>(
          initialValue: _leadTimes.contains(minutes) ? minutes : 15,
          decoration: const InputDecoration(labelText: 'Remind me'),
          items: [for (final m in _leadTimes) DropdownMenuItem(value: m, child: Text(m < 60 ? '$m minutes before' : '${m ~/ 60}${m % 60 == 30 ? '.5' : ''} hour${m > 60 ? 's' : ''} before'))],
          onChanged: enabled ? (v) => _save(context, {'minutes_before': v}) : null,
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            icon: const Icon(Icons.send_outlined, size: 18),
            label: const Text('Send me a test notification'),
            onPressed: () async {
              await context.read<AppState>().api.post('/api/notifications/test');
              await NotificationService.instance.showNow(1, 'Test notification', 'Lecture reminders are working on this device.');
              if (context.mounted) showMessage(context, 'Test sent');
            },
          ),
        ),
      ]),
    );
  }
}

const _researchLead = [15, 30, 60, 120, 180, 360, 720];

/// Reminders for concept presentations and defences the user takes part in.
class _ResearchReminderSettings extends StatelessWidget {
  const _ResearchReminderSettings({required this.prefs, required this.onChanged});
  final Map<String, dynamic> prefs;
  final Future<void> Function() onChanged;

  Future<void> _save(BuildContext context, Map<String, dynamic> patch) async {
    final app = context.read<AppState>();
    try {
      await app.api.put('/api/notifications/preferences', {...prefs, ...patch});
      final scheduled = await app.syncReminders();
      if (context.mounted) {
        showMessage(context, NotificationService.instance.supported ? 'Saved - $scheduled reminder(s) scheduled on this phone' : 'Reminder settings saved');
      }
      await onChanged();
    } catch (e) {
      if (context.mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = prefs['research_enabled'] != false;
    final minutes = (prefs['research_minutes_before'] as num?)?.toInt() ?? 60;
    return SectionCard(
      title: 'Presentations and defences',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Remind me before research presentations and defences'),
          subtitle: const Text('Ones you present, supervise, coordinate or approve'),
          value: enabled,
          onChanged: (v) async {
            if (v) await NotificationService.instance.requestPermission();
            if (context.mounted) await _save(context, {'research_enabled': v});
          },
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Also remind me the day before'),
          value: prefs['research_day_before'] != false,
          onChanged: enabled ? (v) => _save(context, {'research_day_before': v}) : null,
        ),
        DropdownButtonFormField<int>(
          initialValue: _researchLead.contains(minutes) ? minutes : 60,
          decoration: const InputDecoration(labelText: 'Remind me'),
          items: [for (final m in _researchLead) DropdownMenuItem(value: m, child: Text(m < 60 ? '$m minutes before' : '${m ~/ 60} hour${m > 60 ? 's' : ''} before'))],
          onChanged: enabled ? (v) => _save(context, {'research_minutes_before': v}) : null,
        ),
      ]),
    );
  }
}
