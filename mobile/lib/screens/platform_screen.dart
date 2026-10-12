import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// SaaS operator view: all universities on the platform.
class PlatformScreen extends StatelessWidget {
  const PlatformScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Universities'),
        actions: [IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: app.logout)],
      ),
      body: AsyncView<List>(
        load: () async => await app.api.get('/api/platform/universities') as List,
        builder: (context, unis, reload) => ListView(padding: const EdgeInsets.all(12), children: [
          for (final u in unis)
            Card(
              child: ListTile(
                leading: CircleAvatar(backgroundColor: hexColor(u['primary_color'] as String?), child: Text((u['short_name'] ?? u['name'] as String).substring(0, 1), style: const TextStyle(color: Colors.white))),
                title: Text(u['name'] as String),
                subtitle: Text('${u['faculties']} faculties · ${u['lecturers']} lecturers · ${u['students']} students'),
                trailing: Switch(
                  value: u['active'] == 1,
                  onChanged: (v) async {
                    try {
                      await app.api.put('/api/platform/universities/${u['id']}', {'active': v});
                      await reload();
                    } catch (e) {
                      if (context.mounted) showError(context, e);
                    }
                  },
                ),
              ),
            ),
        ]),
      ),
    );
  }
}
