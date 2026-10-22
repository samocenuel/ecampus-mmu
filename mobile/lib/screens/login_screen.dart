import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'register_screen.dart';

const _roleIcons = {
  'admin': Icons.account_balance_outlined,
  'dean': Icons.domain_outlined,
  'hod': Icons.account_tree_outlined,
  'lecturer': Icons.menu_book_outlined,
  'class_rep': Icons.fact_check_outlined,
  'student': Icons.person_outline,
  'part_time': Icons.work_history_outlined,
  'hr': Icons.badge_outlined,
};

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _hide = true;
  List<Map<String, dynamic>> _demoRoles = const [];

  @override
  void initState() {
    super.initState();
    _loadDemo();
  }

  /// "Try the demo" appears once the demo list loads; retried so a slow or restarting server doesn't hide it.
  Future<void> _loadDemo([int attempt = 1]) async {
    try {
      final demo = await context.read<AppState>().api.get('/api/auth/demo');
      final roles = demo['available'] == true ? (demo['roles'] as List).cast<Map<String, dynamic>>() : <Map<String, dynamic>>[];
      if (mounted) setState(() => _demoRoles = roles);
    } catch (_) {
      if (!mounted) return;
      setState(() => _demoRoles = const []);
      if (attempt < 5) {
        await Future<void>.delayed(Duration(seconds: 2 * attempt));
        if (mounted) _loadDemo(attempt + 1);
      }
    }
  }

  Future<void> _login() async {
    setState(() => _busy = true);
    try {
      await context.read<AppState>().login(_email.text.trim(), _password.text);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openDemo() async {
    final app = context.read<AppState>();
    final role = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('Try the demo', style: Theme.of(sheet).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text('Explore Demo University with sample timetables and attendance. Choose a role.',
                style: TextStyle(color: Theme.of(sheet).colorScheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            for (final r in _demoRoles)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundColor: Theme.of(sheet).colorScheme.primaryContainer,
                    child: Icon(_roleIcons[r['key']] ?? Icons.person_outline, color: Theme.of(sheet).colorScheme.onPrimaryContainer),
                  ),
                  title: Text(r['label'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(r['description'] as String? ?? ''),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(sheet).pop(r['key'] as String),
                ),
              ),
          ]),
        ),
      ),
    );
    if (role == null || !mounted) return;
    setState(() => _busy = true);
    try {
      await app.loginDemo(role);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _editServer() async {
    final app = context.read<AppState>();
    final controller = TextEditingController(text: app.api.baseUrl);
    final url = await showDialog<String>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Server'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.url,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Server address', hintText: 'https://www.studio13developers.com/ecampus'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialog).pop(), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(dialog).pop(controller.text), child: const Text('Save')),
        ],
      ),
    );
    if (url == null || url.trim().isEmpty) return;
    await app.setServerUrl(url);
    await _loadDemo();
    if (mounted) showMessage(context, 'Server address saved');
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: AutofillGroup(
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Row(children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(color: scheme.primary, borderRadius: BorderRadius.circular(14)),
                      child: Icon(Icons.school_rounded, color: scheme.onPrimary, size: 28),
                    ),
                    const SizedBox(width: 12),
                    Expanded(child: Text('eCampus', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700))),
                  ]),
                  const SizedBox(height: 28),
                  Text('Sign in', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text('Use the account your university administrator created for you.', style: TextStyle(color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 20),
                  TextField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username],
                    decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.alternate_email)),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    obscureText: _hide,
                    autofillHints: const [AutofillHints.password],
                    onSubmitted: (_) => _login(),
                    decoration: InputDecoration(
                      labelText: 'Password',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(icon: Icon(_hide ? Icons.visibility : Icons.visibility_off), onPressed: () => setState(() => _hide = !_hide)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: _busy ? null : _login,
                    icon: _busy ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.login),
                    label: const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('Sign in')),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const RegisterScreen())),
                    child: const Text('New institution? Create your university'),
                  ),
                  if (_demoRoles.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Row(children: [
                      const Expanded(child: Divider()),
                      Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Text('OR', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12))),
                      const Expanded(child: Divider()),
                    ]),
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _busy ? null : _openDemo,
                      icon: const Icon(Icons.play_circle_outline),
                      label: const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('Try the demo (no account needed)')),
                    ),
                  ],
                  const SizedBox(height: 24),
                  Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                    TextButton(
                      onPressed: () => launchUrl(Uri.parse('${context.read<AppState>().api.baseUrl}/privacy'), mode: LaunchMode.externalApplication),
                      child: Text('Privacy policy', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12.5)),
                    ),
                    Text('·', style: TextStyle(color: scheme.onSurfaceVariant)),
                    TextButton(
                      onPressed: _editServer,
                      child: Text('Server settings', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12.5)),
                    ),
                  ]),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
