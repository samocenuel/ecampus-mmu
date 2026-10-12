import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

const presetColours = ['#1E5AA8', '#0B6E4F', '#7A1F5C', '#B42318', '#B54708', '#1D2939', '#5925DC', '#027A8F', '#4E5BA6', '#8E6C00'];

class PickedImage {
  PickedImage(this.bytes, this.name, this.mime);
  final Uint8List bytes;
  final String name;
  final String mime;
}

Future<PickedImage?> pickLogo(BuildContext context) async {
  final file = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['png', 'jpg', 'jpeg', 'webp']);
  if (file == null) return null;
  final bytes = await file.readAsBytes();
  if (bytes.length > 2 * 1024 * 1024) {
    if (context.mounted) showMessage(context, 'The logo must be smaller than 2 MB', error: true);
    return null;
  }
  final ext = (file.extension ?? 'png').toLowerCase();
  final mime = ext == 'png' ? 'image/png' : ext == 'webp' ? 'image/webp' : 'image/jpeg';
  return PickedImage(bytes, file.name, mime);
}

class ColourPicker extends StatelessWidget {
  const ColourPicker({super.key, required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(spacing: 10, runSpacing: 10, children: [
      for (final c in presetColours)
        InkWell(
          onTap: () => onChanged(c),
          borderRadius: BorderRadius.circular(10),
          child: Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: hexColor(c),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: value.toUpperCase() == c ? Theme.of(context).colorScheme.onSurface : Colors.transparent, width: 3),
            ),
            child: value.toUpperCase() == c ? const Icon(Icons.check, color: Colors.white, size: 18) : null,
          ),
        ),
    ]);
  }
}

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  int _step = 0;
  bool _busy = false;
  PickedImage? _logo;
  String _colour = '#1E5AA8';
  final _f = {for (final k in ['name', 'short_name', 'address', 'email', 'phone', 'website', 'admin_name', 'admin_email', 'password', 'confirm']) k: TextEditingController()};
  final _keys = [GlobalKey<FormState>(), GlobalKey<FormState>(), GlobalKey<FormState>()];

  Future<void> _submit() async {
    if (_f['password']!.text != _f['confirm']!.text) return showMessage(context, 'Passwords do not match', error: true);
    setState(() => _busy = true);
    final app = context.read<AppState>();
    try {
      await app.registerUniversity({
        'name': _f['name']!.text,
        'short_name': _f['short_name']!.text,
        'address': _f['address']!.text,
        'email': _f['email']!.text,
        'phone': _f['phone']!.text,
        'website': _f['website']!.text,
        'primary_color': _colour,
        'timezone': 'Africa/Kampala',
      }, {
        'name': _f['admin_name']!.text,
        'email': _f['admin_email']!.text,
        'password': _f['password']!.text,
      });
      if (_logo != null) {
        try {
          final uni = await app.api.upload('/api/university/logo', 'logo', _logo!.bytes, _logo!.name, _logo!.mime);
          app.setUniversity(uni as Map<String, dynamic>);
        } catch (_) {
          // The university exists; the logo can be uploaded again from settings.
        }
      }
      if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _field(String key, String label, {bool required = false, TextInputType? type, bool obscure = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextFormField(
          controller: _f[key],
          keyboardType: type,
          obscureText: obscure,
          decoration: InputDecoration(labelText: required ? '$label *' : label),
          validator: (v) {
            if (required && (v == null || v.trim().isEmpty)) return 'Required';
            if (obscure && (v ?? '').length < 8) return 'At least 8 characters';
            return null;
          },
        ),
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create your university')),
      body: Stepper(
        currentStep: _step,
        onStepTapped: (s) => setState(() => _step = s),
        onStepCancel: _step == 0 ? null : () => setState(() => _step--),
        onStepContinue: () {
          if (!(_keys[_step].currentState?.validate() ?? true)) return;
          if (_step < 2) {
            setState(() => _step++);
          } else {
            _submit();
          }
        },
        controlsBuilder: (context, details) => Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(children: [
            FilledButton(onPressed: _busy ? null : details.onStepContinue, child: Text(_step < 2 ? 'Continue' : 'Create university')),
            if (_step > 0) TextButton(onPressed: details.onStepCancel, child: const Text('Back')),
            if (_busy) const Padding(padding: EdgeInsets.only(left: 12), child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))),
          ]),
        ),
        steps: [
          Step(
            title: const Text('University details'),
            isActive: _step >= 0,
            content: Form(
              key: _keys[0],
              child: Column(children: [
                _field('name', 'University name', required: true),
                _field('short_name', 'Short name (e.g. MMU)'),
                _field('address', 'Physical address'),
                _field('email', 'Contact email', type: TextInputType.emailAddress),
                _field('phone', 'Phone', type: TextInputType.phone),
                _field('website', 'Website', type: TextInputType.url),
              ]),
            ),
          ),
          Step(
            title: const Text('Logo & theme colour'),
            isActive: _step >= 1,
            content: Form(
              key: _keys[1],
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                OutlinedButton.icon(
                  onPressed: () async {
                    final img = await pickLogo(context);
                    if (img != null) setState(() => _logo = img);
                  },
                  icon: _logo != null ? ClipRRect(borderRadius: BorderRadius.circular(4), child: Image.memory(_logo!.bytes, width: 28, height: 28, fit: BoxFit.contain)) : const Icon(Icons.add_photo_alternate_outlined),
                  label: Text(_logo != null ? 'Change logo' : 'Import logo'),
                ),
                const SizedBox(height: 16),
                const Text('Primary theme colour', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                ColourPicker(value: _colour, onChanged: (c) => setState(() => _colour = c)),
                const SizedBox(height: 12),
                FilledButton(style: FilledButton.styleFrom(backgroundColor: hexColor(_colour)), onPressed: () {}, child: const Text('Preview button')),
              ]),
            ),
          ),
          Step(
            title: const Text('Administrator account'),
            isActive: _step >= 2,
            content: Form(
              key: _keys[2],
              child: Column(children: [
                _field('admin_name', 'Your full name', required: true),
                _field('admin_email', 'Email', required: true, type: TextInputType.emailAddress),
                _field('password', 'Password', required: true, obscure: true),
                _field('confirm', 'Confirm password', required: true, obscure: true),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}
