import 'dart:convert';
import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// Result of a QR scan: checked in now, saved to send later (no network), or refused.
class ScanResult {
  ScanResult({required this.ok, required this.message, this.queued = false, this.data = const {}});
  final bool ok;
  final bool queued;
  final String message;
  final Map<String, dynamic> data;
}

/// Student QR check-in: the phone's ID and a queue of scans made while offline.
///
/// The phone ID is random and kept on the phone, so one phone checks in one
/// student per lecture. Reinstalling the app gives a new ID, which counts as
/// the term's one phone change.
class CheckinService {
  CheckinService._();
  static final instance = CheckinService._();

  static const _deviceKey = 'checkin_device_id';
  static const _queueKey = 'checkin_pending_scans';

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  Future<String> deviceId() async {
    final prefs = await _prefs;
    var id = prefs.getString(_deviceKey);
    if (id == null) {
      final rnd = Random.secure();
      id = 'ec-${List.generate(16, (_) => rnd.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
      await prefs.setString(_deviceKey, id);
    }
    return id;
  }

  /// eCampus codes look like `EC1.<id>.<step>.<signature>`.
  static bool looksLikeCode(String? raw) => raw != null && RegExp(r'^EC1\.\d+\.\d+\.[A-Za-z0-9_-]{16}$').hasMatch(raw.trim());

  Future<List<Map<String, dynamic>>> pending() async {
    final raw = (await _prefs).getString(_queueKey);
    if (raw == null) return [];
    try {
      return (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    } catch (_) {
      return [];
    }
  }

  Future<void> _savePending(List<Map<String, dynamic>> list) async {
    final prefs = await _prefs;
    if (list.isEmpty) {
      await prefs.remove(_queueKey);
    } else {
      await prefs.setString(_queueKey, jsonEncode(list));
    }
  }

  Future<ScanResult> scan(Api api, String code) async {
    final at = DateTime.now().toUtc().toIso8601String();
    try {
      final res = await _send(api, code, at);
      return ScanResult(ok: true, message: _success(res), data: res);
    } on ApiException catch (e) {
      if (e.status == 0) {
        final list = await pending();
        if (!list.any((p) => p['code'] == code)) list.add({'code': code, 'scanned_at': at});
        await _savePending(list);
        return ScanResult(ok: true, queued: true, message: 'No connection. Your scan is saved with its time and will be sent when you are back online.');
      }
      return ScanResult(ok: false, message: e.message, data: e.data);
    }
  }

  /// Sends saved scans. Returns messages for the ones that were accepted or refused.
  Future<List<ScanResult>> flush(Api api) async {
    final list = await pending();
    if (list.isEmpty) return [];
    final results = <ScanResult>[];
    final keep = <Map<String, dynamic>>[];
    for (final p in list) {
      try {
        final res = await _send(api, p['code'] as String, p['scanned_at'] as String);
        results.add(ScanResult(ok: true, message: _success(res), data: res));
      } on ApiException catch (e) {
        if (e.status == 0) {
          keep.add(p);
        } else {
          results.add(ScanResult(ok: false, message: e.message, data: e.data));
        }
      }
    }
    await _savePending(keep);
    return results;
  }

  Future<Map<String, dynamic>> _send(Api api, String code, String scannedAt) async =>
      await api.post('/api/checkin/scan', {'code': code.trim(), 'device_id': await deviceId(), 'scanned_at': scannedAt}) as Map<String, dynamic>;

  String _success(Map<String, dynamic> r) {
    final what = '${r['course_code'] ?? ''}${r['class_name'] != null ? ' · ${r['class_name']}' : ''}';
    if (r['already'] == true) return 'You are already checked in to $what.';
    return 'Checked in to $what.${r['phone_changed'] == true ? ' This phone is now your registered phone.' : ''}';
  }
}
