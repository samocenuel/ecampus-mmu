import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';
import 'register_screen.dart';

const _demoAccounts = [
  ('Administrator', 'admin@demo.edu'),
  ('Dean', 'dean.fst@demo.edu'),
  ('Head of Dept', 'hod.cs@demo.edu'),
  ('Lecturer', 'brian.kato@demo.edu'),
  ('Class rep', 'rep.bscs1@students.demo.edu'),
  ('Student', 'student.bscs1@students.demo.edu'),
];
const _demoPassword = 'Passw0rd!';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  late final TextEditingController _server;
  bool _busy = false;
  bool _demo = false;
  bool _hide = true;

  @override
  void initState() {
    super.initState();
    _server = TextEditingController(text: context.read<AppState>().api.baseUrl);
    _checkServer();
  }

  Future<void> _checkServer() async {
    try {
      final health = await context.read<AppState>().api.get('/api/health');
      if (mounted) setState(() => _demo = health['demo'] == true);
    } catch (_) {
      if (mounted) setState(() => _demo = false);
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
                    Expanded(child: Text('eCampus MMU', style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700))),
                  ]),
                  const SizedBox(height: 28),
                  Text('Sign in', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text('Timetables, attendance and reminders for your university.', style: TextStyle(color: scheme.onSurfaceVariant)),
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
                  TextButton(
                    onPressed: () => launchUrl(Uri.parse('${context.read<AppState>().api.baseUrl}/privacy'), mode: LaunchMode.externalApplication),
                    child: Text('Privacy policy', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12.5)),
                  ),
                  const SizedBox(height: 8),
                  ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    leading: const Icon(Icons.dns_outlined),
                    title: const Text('Server'),
                    subtitle: Text(context.watch<AppState>().api.baseUrl, style: const TextStyle(fontSize: 12)),
                    children: [
                      Row(children: [
                        Expanded(
                          child: TextField(
                            controller: _server,
                            keyboardType: TextInputType.url,
                            decoration: const InputDecoration(labelText: 'API address', hintText: 'http://192.168.1.10:4000'),
                          ),
                        ),
                        const SizedBox(width: 8),
                        FilledButton.tonal(
                          onPressed: () async {
                            await context.read<AppState>().setServerUrl(_server.text);
                            await _checkServer();
                            if (context.mounted) showMessage(context, _demo ? 'Connected (demo data available)' : 'Server address saved');
                          },
                          child: const Text('Save'),
                        ),
                      ]),
                      const SizedBox(height: 8),
                    ],
                  ),
                  if (_demo) ...[
                    const SizedBox(height: 8),
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          const Text('Demo accounts', style: TextStyle(fontWeight: FontWeight.w600)),
                          Text('Password for all: $_demoPassword', style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12)),
                          const SizedBox(height: 10),
                          Wrap(spacing: 8, runSpacing: 8, children: [
                            for (final (label, email) in _demoAccounts)
                              ActionChip(
                                label: Text(label),
                                onPressed: () => setState(() {
                                  _email.text = email;
                                  _password.text = _demoPassword;
                                }),
                              ),
                          ]),
                        ]),
                      ),
                    ),
                  ],
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
