import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;

  Future<void> _change() async {
    if (_next.text != _confirm.text) return showMessage(context, 'New passwords do not match', error: true);
    setState(() => _busy = true);
    try {
      await context.read<AppState>().api.post('/api/auth/change-password', {'current_password': _current.text, 'new_password': _next.text});
      if (!mounted) return;
      showMessage(context, 'Password changed');
      for (final c in [_current, _next, _confirm]) {
        c.clear();
      }
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _deleteAccount() async {
    final password = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(Icons.warning_amber_rounded, color: Theme.of(ctx).colorScheme.error),
        title: const Text('Delete your account?'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Your name, email, phone and other personal details are erased and you will be signed out. '
              'Anonymised attendance records are kept for your university. This cannot be undone.'),
          const SizedBox(height: 12),
          TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm with your password')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete account'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final app = context.read<AppState>();
    try {
      await app.api.post('/api/auth/delete-account', {'password': password.text});
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      await app.logout();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final u = context.watch<AppState>().user!;
    Widget row(String label, Object? value) => value == null
        ? const SizedBox.shrink()
        : ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(label), trailing: Text('$value', style: const TextStyle(fontWeight: FontWeight.w600)));
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        SectionCard(
          title: '${u['title'] ?? ''} ${u['name']}'.trim(),
          child: Column(children: [
            row('Email', u['email']),
            row('Role', roleLabels[u['role']]),
            row(u['role'] == 'student' ? 'Registration no.' : 'Staff no.', u['identifier']),
            row('Faculty', u['faculty_name']),
            row('Department', u['department_name']),
            row('Class', u['class_name']),
            if (u['is_class_rep'] == true) row('Class representative for', (u['rep_classes'] as List).map((c) => c['name']).join(', ')),
          ]),
        ),
        SectionCard(
          title: 'Change password',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            TextField(controller: _current, obscureText: true, decoration: const InputDecoration(labelText: 'Current password')),
            const SizedBox(height: 10),
            TextField(controller: _next, obscureText: true, decoration: const InputDecoration(labelText: 'New password (min 8 characters)')),
            const SizedBox(height: 10),
            TextField(controller: _confirm, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm new password')),
            const SizedBox(height: 12),
            FilledButton(onPressed: _busy ? null : _change, child: const Text('Update password')),
          ]),
        ),
        SectionCard(
          title: 'Delete account',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Permanently erase your personal details and sign out.'),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
              onPressed: _deleteAccount,
              icon: const Icon(Icons.delete_forever_outlined),
              label: const Text('Delete my account'),
            ),
          ]),
        ),
      ]),
    );
  }
}
