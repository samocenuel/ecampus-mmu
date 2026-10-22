import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'checkin_service.dart';
import 'notifications.dart';

/// Servers earlier versions used by default; saved copies of them are replaced on start.
const _retiredServers = {'https://ecampus-mmu.onrender.com'};

/// Default API address. Override at build time with
/// `--dart-define=API_URL=https://your-server`, or from the sign-in screen.
String defaultServerUrl() {
  const fromEnv = String.fromEnvironment('API_URL');
  if (fromEnv.isNotEmpty) return fromEnv;
  if (kIsWeb) {
    // When the web build is served by the API itself, use the same origin.
    final base = Uri.base;
    if (base.port == 4000 || (base.scheme == 'https' && !base.host.contains('localhost'))) return base.origin;
    return 'http://${base.host}:4000';
  }
  // The Android emulator reaches the host machine on 10.0.2.2.
  if (defaultTargetPlatform == TargetPlatform.android) return 'http://10.0.2.2:4000';
  return 'http://localhost:4000';
}

Color hexColor(String? hex, [Color fallback = const Color(0xFF1E5AA8)]) {
  final h = (hex ?? '').replaceAll('#', '');
  if (h.length != 6) return fallback;
  final v = int.tryParse(h, radix: 16);
  return v == null ? fallback : Color(0xFF000000 | v);
}

class AppState extends ChangeNotifier {
  late Api api;
  SharedPreferences? _prefs;
  Map<String, dynamic>? user;
  Map<String, dynamic>? university;
  bool initialising = true;
  int unread = 0;
  Timer? _poll;
  int _lastSeenNotification = -1;

  /// Shown as an in-app banner when a new notification arrives.
  final ValueNotifier<Map<String, dynamic>?> incoming = ValueNotifier(null);

  String get role => user?['role'] as String? ?? '';
  bool get isAdmin => role == 'admin';
  bool get isManager => const ['admin', 'dean', 'hod'].contains(role);
  bool get teaches => const ['lecturer', 'hod', 'dean'].contains(role);
  bool get isStudent => role == 'student';
  bool get isStaff => const ['admin', 'dean', 'hod', 'lecturer'].contains(role);
  bool get isClassRep => user?['is_class_rep'] == true;
  bool get isSuperAdmin => role == 'super_admin';
  bool get isHr => role == 'hr';
  bool get isPartTimer => teaches && user?['employment_type'] == 'part_time';
  /// HoDs, Deans, HR and admins take part in approving part-time pay claims.
  bool get approvesClaims => const ['admin', 'dean', 'hod', 'hr'].contains(role);
  /// Accounts created by an administrator must choose their own password first.
  bool get mustChangePassword => user?['must_change_password'] == true;
  String? get photoUrl => api.absolute(user?['photo_url'] as String?);
  Color get seedColor => hexColor(university?['primary_color'] as String?);
  String? get logoUrl => api.absolute(university?['logo_url'] as String?);

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    // 1.0.0 pointed at the free demo server; forget it so the new default applies.
    if (_retiredServers.contains(_prefs!.getString('server_url'))) {
      await _prefs!.remove('server_url');
      await _prefs!.remove('token');
    }
    api = Api(_prefs!.getString('server_url') ?? defaultServerUrl());
    api.token = _prefs!.getString('token');
    await NotificationService.instance.init();
    if (api.token != null) {
      try {
        await refreshMe();
        _startPolling();
      } catch (_) {
        await _clearSession();
      }
    }
    initialising = false;
    notifyListeners();
  }

  Future<void> setServerUrl(String url) async {
    api.baseUrl = url.trim().replaceAll(RegExp(r'/$'), '');
    await _prefs?.setString('server_url', api.baseUrl);
    notifyListeners();
  }

  Future<void> refreshMe() async {
    final me = await api.get('/api/auth/me') as Map<String, dynamic>;
    user = me['user'] as Map<String, dynamic>;
    university = me['university'] as Map<String, dynamic>?;
    notifyListeners();
  }

  Future<void> _acceptSession(Map<String, dynamic> session) async {
    api.token = session['token'] as String;
    await _prefs?.setString('token', api.token!);
    user = session['user'] as Map<String, dynamic>;
    university = session['university'] as Map<String, dynamic>?;
    _lastSeenNotification = -1;
    _startPolling();
    notifyListeners();
    unawaited(syncReminders());
  }

  Future<void> login(String email, String password) async {
    final session = await api.post('/api/auth/login', {'email': email, 'password': password});
    await _acceptSession(session as Map<String, dynamic>);
  }

  /// Signs in to the server's Demo University as [role] without an account.
  Future<void> loginDemo(String role) async {
    final session = await api.post('/api/auth/demo', {'role': role});
    await _acceptSession(session as Map<String, dynamic>);
  }

  Future<void> registerUniversity(Map<String, dynamic> university, Map<String, dynamic> admin) async {
    final session = await api.post('/api/auth/register-university', {'university': university, 'admin': admin});
    await _acceptSession(session as Map<String, dynamic>);
  }

  void setUser(Map<String, dynamic> u) {
    user = u;
    notifyListeners();
  }

  void setUniversity(Map<String, dynamic> u) {
    university = u;
    notifyListeners();
  }

  Future<void> logout() async {
    await _clearSession();
    notifyListeners();
  }

  Future<void> _clearSession() async {
    _poll?.cancel();
    api.token = null;
    user = null;
    university = null;
    unread = 0;
    await _prefs?.remove('token');
  }

  /// Re-schedule phone reminders from the server's upcoming lecture list.
  Future<int> syncReminders() async {
    if (user == null || !NotificationService.instance.supported || !(isStudent || teaches)) return 0;
    try {
      final upcoming = await api.get('/api/notifications/upcoming?days=14') as Map<String, dynamic>;
      return await NotificationService.instance.scheduleLectureReminders(upcoming);
    } catch (_) {
      return 0;
    }
  }

  void _startPolling() {
    _poll?.cancel();
    if (isSuperAdmin) return;
    _checkNotifications();
    _poll = Timer.periodic(const Duration(seconds: 45), (_) => _checkNotifications());
  }

  Future<void> _checkNotifications() async {
    if (api.token == null) return;
    // Check-in scans made without a connection are sent once the phone is back online.
    if (isStudent) unawaited(CheckinService.instance.flush(api).catchError((_) => <ScanResult>[]));
    try {
      final res = await api.get('/api/notifications?limit=10') as Map<String, dynamic>;
      final items = (res['items'] as List).cast<Map<String, dynamic>>();
      unread = (res['unread_count'] as num).toInt();
      final maxId = items.fold<int>(0, (m, n) => (n['id'] as num).toInt() > m ? (n['id'] as num).toInt() : m);
      if (_lastSeenNotification >= 0) {
        for (final n in items.reversed) {
          final id = (n['id'] as num).toInt();
          if (id > _lastSeenNotification && n['read_at'] == null) {
            incoming.value = n;
            // Server-generated reminders are already scheduled locally on phones.
            if (n['type'] != 'reminder') {
              unawaited(NotificationService.instance.showNow(id, n['title'] as String, n['body'] as String?));
            }
          }
        }
      }
      _lastSeenNotification = maxId;
      notifyListeners();
    } catch (_) {
      // Offline - try again on the next tick.
    }
  }

  void markAllRead() {
    unread = 0;
    notifyListeners();
  }

  /// Opens an export (PDF / Excel) in the browser using a short-lived download token.
  Future<void> openExport(String pathWithQuery) async {
    final res = await api.post('/api/auth/download-token') as Map<String, dynamic>;
    final sep = pathWithQuery.contains('?') ? '&' : '?';
    final url = Uri.parse('${api.baseUrl}$pathWithQuery${sep}token=${res['token']}');
    if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
      throw ApiException(0, {}, 'Could not open $url');
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }
}
