import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mmu_lms/core/app_state.dart';
import 'package:mmu_lms/widgets/common.dart';

void main() {
  test('hexColor parses university colours and falls back on bad input', () {
    expect(hexColor('#0B6E4F'), const Color(0xFF0B6E4F));
    expect(hexColor('nonsense'), const Color(0xFF1E5AA8));
  });

  test('date helpers format ISO dates', () {
    expect(isoDate(DateTime(2026, 10, 5)), '2026-10-05');
    expect(niceDate('2026-10-12'), 'Mon 12 Oct 2026');
  });

  testWidgets('StatusChip shows a readable label', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: StatusChip('submitted'))));
    expect(find.text('Awaiting approval'), findsOneWidget);
  });
}
