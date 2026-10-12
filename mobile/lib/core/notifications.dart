import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

/// Lecture reminders as real phone notifications (Android / iOS).
///
/// The server returns the user's upcoming lectures (in the university's
/// timezone) and their preferred lead time; we schedule one local
/// notification per lecture so reminders fire even when the app is closed.
/// On the web the app shows in-app banners instead.
class NotificationService {
  NotificationService._();
  static final NotificationService instance = NotificationService._();

  final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  static const _reminderBaseId = 1000;
  static const _maxReminders = 60;

  bool get supported => !kIsWeb && (defaultTargetPlatform == TargetPlatform.android || defaultTargetPlatform == TargetPlatform.iOS);

  static const _details = NotificationDetails(
    android: AndroidNotificationDetails(
      'lecture_reminders',
      'Lecture reminders',
      channelDescription: 'Reminders before your lectures start',
      importance: Importance.high,
      priority: Priority.high,
    ),
    iOS: DarwinNotificationDetails(),
  );

  Future<void> init() async {
    if (!supported || _ready) return;
    tzdata.initializeTimeZones();
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false),
      ),
    );
    _ready = true;
  }

  Future<bool> requestPermission() async {
    if (!supported) return false;
    await init();
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (android != null) return await android.requestNotificationsPermission() ?? false;
    final ios = _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>();
    if (ios != null) return await ios.requestPermissions(alert: true, badge: true, sound: true) ?? false;
    return false;
  }

  /// Replace all scheduled lecture reminders with those in [upcoming]
  /// (the payload of `GET /api/notifications/upcoming`). Returns how many were scheduled.
  Future<int> scheduleLectureReminders(Map<String, dynamic> upcoming) async {
    if (!supported) return 0;
    await init();
    for (var i = 0; i < _maxReminders; i++) {
      await _plugin.cancel(id: _reminderBaseId + i);
    }
    if (upcoming['enabled'] != true) return 0;

    tz.Location location;
    try {
      location = tz.getLocation(upcoming['timezone'] as String? ?? 'UTC');
    } catch (_) {
      location = tz.UTC;
    }
    final minutesBefore = (upcoming['minutes_before'] as num?)?.toInt() ?? 15;
    final now = tz.TZDateTime.now(location);
    var count = 0;
    for (final item in (upcoming['items'] as List? ?? const [])) {
      if (count >= _maxReminders) break;
      final date = (item['date'] as String).split('-').map(int.parse).toList();
      final time = (item['start_time'] as String).split(':').map(int.parse).toList();
      final start = tz.TZDateTime(location, date[0], date[1], date[2], time[0], time[1]);
      final when = start.subtract(Duration(minutes: minutesBefore));
      if (!when.isAfter(now)) continue;
      await _plugin.zonedSchedule(
        id: _reminderBaseId + count,
        title: '${item['course_code']} starts in $minutesBefore min',
        body: '${item['course_name']} - ${item['start_time']} in ${item['room_name']}',
        scheduledDate: when,
        notificationDetails: _details,
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
      );
      count++;
    }
    return count;
  }

  /// Show a notification immediately (e.g. a new approval request).
  Future<void> showNow(int id, String title, String? body) async {
    if (!supported) return;
    await init();
    await _plugin.show(id: id, title: title, body: body, notificationDetails: _details);
  }
}
