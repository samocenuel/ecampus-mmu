import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/app_state.dart';
import '../../widgets/common.dart';
import '../register_screen.dart';

/// Admin: university name, contacts, logo and primary theme colour.
class UniversityScreen extends StatefulWidget {
  const UniversityScreen({super.key});

  @override
  State<UniversityScreen> createState() => _UniversityScreenState();
}

class _UniversityScreenState extends State<UniversityScreen> {
  late Map<String, TextEditingController> _c;
  late String _colour;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final u = context.read<AppState>().university ?? {};
    _c = {for (final k in ['name', 'short_name', 'address', 'email', 'phone', 'website', 'timezone']) k: TextEditingController(text: '${u[k] ?? ''}')};
    _colour = (u['primary_color'] as String?) ?? '#1E5AA8';
  }

  Future<void> _save() async {
    setState(() => _busy = true);
    final app = context.read<AppState>();
    try {
      final updated = await app.api.put('/api/university', {for (final e in _c.entries) e.key: e.value.text, 'primary_color': _colour});
      app.setUniversity(updated as Map<String, dynamic>);
      if (mounted) showMessage(context, 'University profile saved');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _uploadLogo() async {
    final img = await pickLogo(context);
    if (img == null || !mounted) return;
    final app = context.read<AppState>();
    try {
      final updated = await app.api.upload('/api/university/logo', 'logo', img.bytes, img.name, img.mime);
      app.setUniversity(updated as Map<String, dynamic>);
      if (mounted) showMessage(context, 'Logo updated');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget field(String k, String label, [TextInputType? type]) => Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(controller: _c[k], keyboardType: type, decoration: InputDecoration(labelText: label)),
        );
    return Scaffold(
      appBar: AppBar(
        title: const Text('University profile'),
        actions: [Padding(padding: const EdgeInsets.only(right: 8), child: FilledButton(onPressed: _busy ? null : _save, child: const Text('Save')))],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SectionCard(
          title: 'Logo',
          child: Row(children: [
            const UniversityLogo(size: 64),
            const SizedBox(width: 16),
            OutlinedButton.icon(onPressed: _uploadLogo, icon: const Icon(Icons.upload), label: const Text('Import logo')),
          ]),
        ),
        SectionCard(
          title: 'Primary theme colour',
          child: ColourPicker(value: _colour, onChanged: (c) => setState(() => _colour = c)),
        ),
        SectionCard(
          title: 'Details & contacts',
          child: Column(children: [
            field('name', 'University name *'),
            field('short_name', 'Short name'),
            field('address', 'Physical address'),
            field('email', 'Email', TextInputType.emailAddress),
            field('phone', 'Phone', TextInputType.phone),
            field('website', 'Website', TextInputType.url),
            field('timezone', 'Timezone (e.g. Africa/Kampala)'),
          ]),
        ),
      ]),
    );
  }
}
