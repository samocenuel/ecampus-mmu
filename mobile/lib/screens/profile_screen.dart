import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// The user's photo, or their initial when there is none.
class UserAvatar extends StatelessWidget {
  const UserAvatar({super.key, this.radius = 26});
  final double radius;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final scheme = Theme.of(context).colorScheme;
    final name = (app.user?['name'] as String?) ?? '?';
    final url = app.photoUrl;
    return CircleAvatar(
      radius: radius,
      backgroundColor: scheme.primaryContainer,
      foregroundImage: url != null ? NetworkImage(url) : null,
      child: Text(name.isEmpty ? '?' : name.substring(0, 1), style: TextStyle(fontSize: radius * 0.85, color: scheme.onPrimaryContainer)),
    );
  }
}

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  bool _uploading = false;

  Future<void> _pickPhoto() async {
    final app = context.read<AppState>();
    final file = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['png', 'jpg', 'jpeg', 'webp']);
    if (file == null || !mounted) return;
    final bytes = await file.readAsBytes();
    if (bytes.length > 3 * 1024 * 1024) {
      if (mounted) showMessage(context, 'Choose a photo smaller than 3 MB', error: true);
      return;
    }
    final ext = (file.extension ?? 'jpg').toLowerCase();
    final mime = ext == 'png' ? 'image/png' : ext == 'webp' ? 'image/webp' : 'image/jpeg';
    setState(() => _uploading = true);
    try {
      final res = await app.api.upload('/api/auth/me/photo', 'photo', bytes, file.name, mime) as Map<String, dynamic>;
      app.setUser(res['user'] as Map<String, dynamic>);
      if (mounted) showMessage(context, 'Profile photo updated');
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _removePhoto() async {
    final app = context.read<AppState>();
    try {
      final res = await app.api.delete('/api/auth/me/photo') as Map<String, dynamic>;
      app.setUser(res['user'] as Map<String, dynamic>);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editDetails() async {
    final app = context.read<AppState>();
    final u = app.user!;
    final name = TextEditingController(text: u['name'] as String? ?? '');
    final title = TextEditingController(text: u['title'] as String? ?? '');
    final phone = TextEditingController(text: u['phone'] as String? ?? '');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Edit my details'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          if (u['role'] != 'student') ...[
            TextField(controller: title, decoration: const InputDecoration(labelText: 'Title (Dr., Mr., Ms....)')),
            const SizedBox(height: 10),
          ],
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Full name')),
          const SizedBox(height: 10),
          TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      final res = await app.api.put('/api/auth/me', {'name': name.text.trim(), 'title': title.text.trim(), 'phone': phone.text.trim()}) as Map<String, dynamic>;
      app.setUser(res['user'] as Map<String, dynamic>);
      if (mounted) showMessage(context, 'Details saved');
    } catch (e) {
      if (mounted) showError(context, e);
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
    final app = context.watch<AppState>();
    final u = app.user!;
    Widget row(String label, Object? value) => value == null || '$value'.isEmpty
        ? const SizedBox.shrink()
        : ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(label), trailing: Text('$value', style: const TextStyle(fontWeight: FontWeight.w600)));
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Center(
          child: Stack(children: [
            const UserAvatar(radius: 48),
            Positioned(
              right: 0,
              bottom: 0,
              child: IconButton.filled(
                tooltip: 'Change photo',
                onPressed: _uploading ? null : _pickPhoto,
                icon: _uploading ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.photo_camera_outlined, size: 18),
              ),
            ),
          ]),
        ),
        if (app.photoUrl != null) Center(child: TextButton(onPressed: _removePhoto, child: const Text('Remove photo'))),
        const SizedBox(height: 8),
        SectionCard(
          title: '${u['title'] ?? ''} ${u['name']}'.trim(),
          trailing: IconButton(tooltip: 'Edit', icon: const Icon(Icons.edit_outlined), onPressed: _editDetails),
          child: Column(children: [
            row('Email', u['email']),
            row('Phone', u['phone']),
            row('Role', roleLabels[u['role']]),
            row(u['role'] == 'student' ? 'Registration no.' : 'Staff no.', u['identifier']),
            row('Faculty', u['faculty_name']),
            row('Department', u['department_name']),
            row('Class', u['class_name']),
            if (u['is_class_rep'] == true) row('Class representative for', (u['rep_classes'] as List).map((c) => c['name']).join(', ')),
          ]),
        ),
        const SectionCard(title: 'Change password', child: ChangePasswordForm()),
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

class ChangePasswordForm extends StatefulWidget {
  const ChangePasswordForm({super.key, this.onChanged, this.currentLabel = 'Current password'});
  final VoidCallback? onChanged;
  final String currentLabel;

  @override
  State<ChangePasswordForm> createState() => _ChangePasswordFormState();
}

class _ChangePasswordFormState extends State<ChangePasswordForm> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;

  Future<void> _change() async {
    if (_next.text != _confirm.text) return showMessage(context, 'New passwords do not match', error: true);
    final app = context.read<AppState>();
    setState(() => _busy = true);
    try {
      final res = await app.api.post('/api/auth/change-password', {'current_password': _current.text, 'new_password': _next.text}) as Map<String, dynamic>?;
      if (!mounted) return;
      showMessage(context, 'Password changed');
      for (final c in [_current, _next, _confirm]) {
        c.clear();
      }
      if (res?['user'] is Map<String, dynamic>) app.setUser(res!['user'] as Map<String, dynamic>);
      widget.onChanged?.call();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(controller: _current, obscureText: true, decoration: InputDecoration(labelText: widget.currentLabel)),
      const SizedBox(height: 10),
      TextField(controller: _next, obscureText: true, decoration: const InputDecoration(labelText: 'New password (min 8 characters)')),
      const SizedBox(height: 10),
      TextField(controller: _confirm, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm new password')),
      const SizedBox(height: 12),
      FilledButton(onPressed: _busy ? null : _change, child: const Text('Update password')),
    ]);
  }
}

/// Shown instead of the app until a user with a temporary password chooses their own.
class ForcedPasswordScreen extends StatelessWidget {
  const ForcedPasswordScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Choose your password'),
        actions: [TextButton(onPressed: app.logout, child: const Text('Sign out'))],
      ),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const UniversityLogo(size: 56),
        const SizedBox(height: 16),
        Text('Welcome, ${(app.user?['name'] as String? ?? '').split(' ').first}', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
        const SizedBox(height: 6),
        const Text('Your account was set up with a temporary password. Choose a new one that only you know before you continue.'),
        const SizedBox(height: 16),
        const SectionCard(child: ChangePasswordForm(currentLabel: 'Temporary password')),
      ]),
    );
  }
}
