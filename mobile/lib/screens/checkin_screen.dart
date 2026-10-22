import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../core/app_state.dart';
import '../core/checkin_service.dart';
import '../widgets/common.dart';

/// Student: scan the code on the projector or the lecturer's phone.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool _busy = false;
  ScanResult? _result;
  int _pending = 0;

  @override
  void initState() {
    super.initState();
    _refreshPending();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _refreshPending() async {
    final n = (await CheckinService.instance.pending()).length;
    if (mounted) setState(() => _pending = n);
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy || _result != null) return;
    final raw = capture.barcodes.map((b) => b.rawValue).firstWhere((v) => v != null, orElse: () => null);
    if (raw == null) return;
    if (!CheckinService.looksLikeCode(raw)) {
      showMessage(context, 'That is not an eCampus check-in code', error: true);
      return;
    }
    setState(() => _busy = true);
    await _controller.stop();
    if (!mounted) return;
    final result = await CheckinService.instance.scan(context.read<AppState>().api, raw);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _result = result;
    });
    _refreshPending();
  }

  Future<void> _again() async {
    setState(() => _result = null);
    await _controller.start();
  }

  Future<void> _sendPending() async {
    final results = await CheckinService.instance.flush(context.read<AppState>().api);
    await _refreshPending();
    if (!mounted) return;
    if (results.isEmpty) {
      showMessage(context, _pending > 0 ? 'Still offline. Try again when you have a connection.' : 'Nothing waiting to be sent');
    } else {
      showMessage(context, results.map((r) => r.message).join('\n'), error: results.any((r) => !r.ok));
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final r = _result;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Check in'),
        actions: [
          IconButton(tooltip: 'Torch', icon: const Icon(Icons.flashlight_on_outlined), onPressed: () => _controller.toggleTorch()),
        ],
      ),
      body: Column(children: [
        if (_pending > 0)
          MaterialBanner(
            content: Text('$_pending ${_pending == 1 ? 'scan is' : 'scans are'} waiting to be sent (made while offline).'),
            actions: [TextButton(onPressed: _sendPending, child: const Text('Send now'))],
          ),
        Expanded(
          child: r == null
              ? Stack(fit: StackFit.expand, children: [
                  MobileScanner(
                    controller: _controller,
                    onDetect: _onDetect,
                    errorBuilder: (context, error) => EmptyView(
                      icon: Icons.no_photography_outlined,
                      title: 'Camera not available',
                      message: error.errorCode == MobileScannerErrorCode.permissionDenied
                          ? 'Allow eCampus to use the camera in your phone settings to scan the check-in code.'
                          : 'The camera could not start (${error.errorCode.name}).',
                    ),
                  ),
                  IgnorePointer(
                    child: Center(
                      child: Container(
                        width: 250,
                        height: 250,
                        decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 3), borderRadius: BorderRadius.circular(20)),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 16,
                    right: 16,
                    bottom: 24,
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(12)),
                      child: Text(
                        _busy ? 'Checking in...' : 'Point the camera at the code shown on the projector or on your lecturer\'s phone.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.white),
                      ),
                    ),
                  ),
                ])
              : Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      CircleAvatar(
                        radius: 40,
                        backgroundColor: !r.ok ? scheme.errorContainer : r.queued ? Colors.orange.shade100 : Colors.green.shade100,
                        child: Icon(!r.ok ? Icons.close : r.queued ? Icons.schedule_send : Icons.check, size: 44, color: !r.ok ? scheme.error : r.queued ? Colors.orange.shade800 : Colors.green.shade700),
                      ),
                      const SizedBox(height: 16),
                      Text(!r.ok ? 'Not checked in' : r.queued ? 'Saved' : 'Checked in', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                      const SizedBox(height: 8),
                      Text(r.message, textAlign: TextAlign.center),
                      if (!r.ok) ...[
                        const SizedBox(height: 8),
                        Text(
                          'If your phone cannot check in (flat battery, no camera), ask your lecturer or class rep to mark you, or send a correction from Attendance within 48 hours.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13),
                        ),
                      ],
                      const SizedBox(height: 24),
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        if (!r.ok) ...[OutlinedButton(onPressed: _again, child: const Text('Scan again')), const SizedBox(width: 12)],
                        FilledButton(onPressed: () => Navigator.pop(context, r.ok), child: const Text('Done')),
                      ]),
                    ]),
                  ),
                ),
        ),
      ]),
    );
  }
}

/// Lecturer (or cover / HoD): show the rotating code, watch the count, mark manually, close.
/// A class rep opens the same screen to mark classmates without phones.
class CheckinHostScreen extends StatefulWidget {
  const CheckinHostScreen({super.key, required this.id});
  final int id;

  @override
  State<CheckinHostScreen> createState() => _CheckinHostScreenState();
}

class _CheckinHostScreenState extends State<CheckinHostScreen> {
  Map<String, dynamic>? _info;
  String? _code;
  int _expires = 0;
  Timer? _tick;
  Timer? _poll;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _load());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (_expires <= 1) {
        _loadCode();
      } else {
        setState(() => _expires--);
      }
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final info = await context.read<AppState>().api.get('/api/checkin/${widget.id}') as Map<String, dynamic>;
      if (!mounted) return;
      final first = _info == null;
      setState(() {
        _info = info;
        _error = null;
      });
      if (first) _loadCode();
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _loadCode() async {
    final info = _info;
    if (info == null || info['can_manage'] != true || info['open'] != true) return;
    _expires = 15;
    try {
      final c = await context.read<AppState>().api.get('/api/checkin/${widget.id}/code') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _code = c['code'] as String;
        _expires = (c['expires_in'] as num).toInt();
      });
    } catch (_) {
      // Shown again on the next tick.
    }
  }

  Future<void> _manual() async {
    final api = context.read<AppState>().api;
    List students;
    try {
      students = await api.get('/api/checkin/${widget.id}/students') as List;
    } catch (e) {
      if (mounted) showError(context, e);
      return;
    }
    if (!mounted) return;
    final picked = await showModalBottomSheet<Map>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _ManualMarkSheet(students: students),
    );
    if (picked == null || !mounted) return;
    try {
      final r = await api.post('/api/checkin/${widget.id}/manual', {'student_id': picked['student_id'], 'reason': picked['reason']}) as Map<String, dynamic>;
      if (!mounted) return;
      showMessage(
        context,
        r['over_limit'] == true
            ? 'Marked. This student has ${r['manual_marks_this_term']} manual marks this term (limit ${r['limit']}); the HoD has been told.'
            : 'Marked present',
      );
      _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _rollCall() async {
    try {
      final list = await context.read<AppState>().api.post('/api/checkin/${widget.id}/rollcall') as List;
      if (!mounted) return;
      await showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Random roll call'),
          content: list.isEmpty
              ? const Text('Nobody has checked in by phone yet.')
              : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Call these names. Anyone missing was checked in by someone else\'s phone: remove them.'),
                  const SizedBox(height: 8),
                  for (final s in list) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(s['name'] as String), subtitle: Text('${s['identifier'] ?? ''} · ${s['class_name']}')),
                ]),
          actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done'))],
        ),
      );
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _remove(Map e) async {
    final ok = await confirmDialog(context, title: 'Remove ${e['name']}?', message: 'They will be marked absent for this lecture.', confirmLabel: 'Remove', danger: true);
    if (!ok || !mounted) return;
    try {
      await context.read<AppState>().api.delete('/api/checkin/${widget.id}/entries/${e['student_id']}');
      _load();
    } catch (err) {
      if (mounted) showError(context, err);
    }
  }

  Future<void> _close() async {
    final ok = await confirmDialog(
      context,
      title: 'Close check-in?',
      message: 'Students who have not checked in are marked absent and the attendance register is saved as approved. You can still add late manual marks.',
      confirmLabel: 'Close',
    );
    if (!ok || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/checkin/${widget.id}/close');
      if (!mounted) return;
      showMessage(context, 'Check-in closed and attendance saved');
      setState(() => _code = null);
      _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    final scheme = Theme.of(context).colorScheme;
    if (info == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Check-in')),
        body: _error != null ? EmptyView(icon: Icons.cloud_off_outlined, title: 'Could not load', message: '$_error') : const Center(child: CircularProgressIndicator()),
      );
    }
    final occ = info['occurrence'] as Map<String, dynamic>;
    final open = info['open'] == true;
    final manage = info['can_manage'] == true;
    final counts = info['counts'] as Map<String, dynamic>;
    final entries = (info['entries'] as List).cast<Map<String, dynamic>>();
    final flags = (info['flags'] as List).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${occ['course_code']} check-in'),
          Text('${occ['start_time']}-${occ['end_time']} · ${occ['room_name']}', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        ]),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: Row(children: [
            if (info['can_mark'] == true)
              Expanded(child: OutlinedButton.icon(onPressed: _manual, icon: const Icon(Icons.person_add_alt), label: const Text('Mark manually'))),
            if (manage && open) ...[
              const SizedBox(width: 8),
              Expanded(child: FilledButton.icon(onPressed: _close, icon: const Icon(Icons.lock_outline), label: const Text('Close'))),
            ],
          ]),
        ),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        if (manage && open)
          Card(
            color: Colors.white,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(children: [
                if (_code != null)
                  LayoutBuilder(
                    builder: (context, c) => QrImageView(data: _code!, size: c.maxWidth.clamp(180, 420).toDouble(), backgroundColor: Colors.white, padding: EdgeInsets.zero),
                  )
                else
                  const SizedBox(height: 240, child: Center(child: CircularProgressIndicator())),
                const SizedBox(height: 8),
                Text('Students scan this with the eCampus app · new code in ${_expires}s', textAlign: TextAlign.center, style: const TextStyle(color: Color(0xFF344054))),
              ]),
            ),
          ),
        if (!open)
          Card(
            color: scheme.surfaceContainerHighest,
            child: const ListTile(leading: Icon(Icons.lock_outline), title: Text('Check-in closed'), subtitle: Text('Attendance has been saved to the register.')),
          ),
        SectionCard(
          title: 'Checked in',
          trailing: manage && open ? TextButton.icon(onPressed: _rollCall, icon: const Icon(Icons.shuffle), label: const Text('Roll call')) : null,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text('${counts['total']}', style: TextStyle(fontSize: 40, fontWeight: FontWeight.w800, color: scheme.primary)),
              const SizedBox(width: 8),
              Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('of ${info['expected']} students')),
            ]),
            Text('${counts['qr']} by phone · ${counts['manual']} manual', style: TextStyle(color: scheme.onSurfaceVariant)),
            const Divider(height: 24),
            if (entries.isEmpty) Text('Nobody has checked in yet.', style: TextStyle(color: scheme.onSurfaceVariant)),
            for (final e in entries)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Icon(e['method'] == 'qr' ? Icons.qr_code_2 : Icons.edit_note, color: e['method'] == 'qr' ? Colors.green.shade600 : Colors.orange.shade800),
                title: Text(e['name'] as String),
                subtitle: Text([e['identifier'], e['class_name'], if (e['method'] != 'qr') 'manual: ${e['reason'] ?? ''}'].whereType<String>().join(' · ')),
                trailing: manage ? IconButton(tooltip: 'Remove', icon: const Icon(Icons.remove_circle_outline), onPressed: () => _remove(e)) : null,
              ),
          ]),
        ),
        if (manage && flags.isNotEmpty)
          SectionCard(
            title: 'Refused attempts',
            child: Column(children: [
              for (final f in flags)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.flag_outlined, color: scheme.error),
                  title: Text(f['name'] as String? ?? 'Unknown'),
                  subtitle: Text('${f['detail'] ?? f['kind']}'),
                ),
            ]),
          ),
      ]),
    );
  }
}

class _ManualMarkSheet extends StatefulWidget {
  const _ManualMarkSheet({required this.students});
  final List students;

  @override
  State<_ManualMarkSheet> createState() => _ManualMarkSheetState();
}

class _ManualMarkSheetState extends State<_ManualMarkSheet> {
  Map? _student;
  String _query = '';
  bool _idChecked = false;
  final _reason = TextEditingController(text: 'Phone battery flat');

  @override
  Widget build(BuildContext context) {
    final list = widget.students.where((s) => '${s['name']} ${s['identifier'] ?? ''}'.toLowerCase().contains(_query.toLowerCase())).toList();
    final s = _student;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.75,
        child: s == null
            ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Mark a student present', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 8),
                TextField(autofocus: true, onChanged: (v) => setState(() => _query = v), decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Name or registration number')),
                const SizedBox(height: 8),
                Expanded(
                  child: list.isEmpty
                      ? const Center(child: Text('Everyone is checked in'))
                      : ListView(children: [
                          for (final st in list)
                            ListTile(title: Text(st['name'] as String), subtitle: Text('${st['identifier'] ?? ''} · ${st['class_name']}'), onTap: () => setState(() => _student = st)),
                        ]),
                ),
              ])
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(s['name'] as String, style: Theme.of(context).textTheme.titleLarge),
                Text('${s['identifier'] ?? ''} · ${s['class_name']}'),
                const SizedBox(height: 12),
                CheckboxListTile(
                  value: _idChecked,
                  onChanged: (v) => setState(() => _idChecked = v == true),
                  contentPadding: EdgeInsets.zero,
                  title: const Text('I have checked the student\'s ID card'),
                  subtitle: const Text('Manual marks are limited each term; the HoD is told when a student passes the limit.'),
                ),
                TextField(controller: _reason, decoration: const InputDecoration(labelText: 'Why can\'t they check in by phone?')),
                const Spacer(),
                Row(children: [
                  OutlinedButton(onPressed: () => setState(() => _student = null), child: const Text('Back')),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton(
                      onPressed: _idChecked && _reason.text.trim().isNotEmpty ? () => Navigator.pop(context, {'student_id': s['id'], 'reason': _reason.text.trim()}) : null,
                      child: const Text('Mark present'),
                    ),
                  ),
                ]),
              ]),
      ),
    );
  }
}
