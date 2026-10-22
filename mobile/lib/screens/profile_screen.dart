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

  static const _contacts = [
    ('phone', 'Phone', TextInputType.phone),
    ('alt_phone', 'Other phone', TextInputType.phone),
    ('contact_email', 'Contact email', TextInputType.emailAddress),
    ('office', 'Office / location', TextInputType.text),
    ('address', 'Address', TextInputType.streetAddress),
    ('emergency_name', 'Emergency contact name', TextInputType.name),
    ('emergency_phone', 'Emergency contact phone', TextInputType.phone),
  ];

  /// People update their own contacts; the name, title and position are kept by the HoD / Dean.
  Future<void> _editContacts() async {
    final app = context.read<AppState>();
    final u = app.user!;
    final c = {for (final (k, _, _) in _contacts) k: TextEditingController(text: u[k] as String? ?? '')};
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('My contacts'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final (k, label, type) in _contacts)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: TextField(controller: c[k], keyboardType: type, maxLines: k == 'address' ? 2 : 1, decoration: InputDecoration(labelText: label)),
              ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      final res = await app.api.put('/api/auth/me', {for (final e in c.entries) e.key: e.value.text.trim()}) as Map<String, dynamic>;
      app.setUser(res['user'] as Map<String, dynamic>);
      if (mounted) showMessage(context, 'Contacts saved');
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  int _deletionVersion = 0;

  /// Deletion is a request the systems administrator approves; the account is then archived before it is erased.
  Future<void> _deleteAccount(int archiveDays) async {
    final password = TextEditingController();
    final reason = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(Icons.warning_amber_rounded, color: Theme.of(ctx).colorScheme.error),
        title: const Text('Ask to delete your account?'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Your systems administrator approves the request. You then can no longer sign in, and after $archiveDays days your name, email, phone numbers and other personal details are erased. '
                'Anonymised attendance records are kept for your university.'),
            const SizedBox(height: 12),
            TextField(controller: reason, maxLines: 2, decoration: const InputDecoration(labelText: 'Reason (optional)')),
            const SizedBox(height: 8),
            TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm with your password')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Send request'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/auth/delete-account', {'password': password.text, 'reason': reason.text});
      if (mounted) showMessage(context, 'Request sent to your systems administrator');
      setState(() => _deletionVersion++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _withdrawDeletion() async {
    try {
      await context.read<AppState>().api.delete('/api/auth/delete-account');
      if (mounted) showMessage(context, 'Deletion request withdrawn');
      setState(() => _deletionVersion++);
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
          child: Column(children: [
            if (u['role'] != 'student') row('Position', u['designation']),
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
          title: 'My contacts',
          trailing: IconButton(tooltip: 'Edit contacts', icon: const Icon(Icons.edit_outlined), onPressed: _editContacts),
          child: Column(children: [
            for (final (k, label, _) in _contacts) row(label, u[k]),
            if (_contacts.every((c) => (u[c.$1] as String? ?? '').isEmpty)) const Text('Add your phone numbers, office and an emergency contact.'),
            const SizedBox(height: 6),
            Text(
              'Your name, title and position are updated by ${const {'hod': 'your Dean or the administrator', 'dean': 'the administrator', 'admin': 'another administrator', 'hr': 'the administrator'}[u['role']] ?? 'your HoD or Dean'}.',
              style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 12),
            ),
          ]),
        ),
        const SectionCard(title: 'Change password', child: ChangePasswordForm()),
        SectionCard(
          title: 'Delete account',
          child: AsyncView<Map<String, dynamic>>(
            key: ValueKey(_deletionVersion),
            load: () async => await app.api.get('/api/auth/delete-account') as Map<String, dynamic>,
            builder: (context, d, _) {
              final r = d['request'] as Map?;
              final days = (d['archive_days'] as num?)?.toInt() ?? 30;
              if (r?['status'] == 'pending') {
                return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  const Text('You asked to delete your account. Your systems administrator has not decided yet.'),
                  const SizedBox(height: 10),
                  OutlinedButton(onPressed: _withdrawDeletion, child: const Text('Withdraw the request')),
                ]);
              }
              return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Ask for your account to be deleted. After your systems administrator approves, it is archived for $days days (it can still be restored), then your personal details are erased.'),
                if (r?['status'] == 'rejected') Padding(padding: const EdgeInsets.only(top: 6), child: Text('Your last request was not approved: ${r?['decision_note'] ?? ''}')),
                const SizedBox(height: 10),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                  onPressed: () => _deleteAccount(days),
                  icon: const Icon(Icons.delete_forever_outlined),
                  label: const Text('Delete my account'),
                ),
              ]);
            },
          ),
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
