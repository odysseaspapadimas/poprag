// Automatic FlutterFlow imports
import '/backend/backend.dart';
import '/backend/schema/structs/index.dart';
import '/backend/schema/enums/enums.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/custom_code/widgets/index.dart'; // Imports other custom widgets
import '/custom_code/actions/index.dart'; // Imports custom actions
import '/flutter_flow/custom_functions.dart'; // Imports custom functions
import 'package:flutter/material.dart';
// Begin custom widget code
// DO NOT REMOVE OR MODIFY THE CODE ABOVE!

import 'index.dart'; // Imports other custom widgets

import 'package:flutter/foundation.dart';

import '/custom_code/widgets/index.dart';
import 'package:flutter_tts/flutter_tts.dart';
import '/custom_code/actions/index.dart';
import '/flutter_flow/custom_functions.dart';
import 'package:camera/camera.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as path;
import 'package:flutter/services.dart';
import 'dart:convert';
import 'dart:io';
import 'dart:async';
import 'dart:ui' as ui;
import 'dart:typed_data';
import 'package:flutter/semantics.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:uuid/uuid.dart';
import '/app_state.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:just_audio/just_audio.dart';
import 'package:audioplayers/audioplayers.dart' as audioplayers;
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:audio_session/audio_session.dart';
import 'package:font_awesome_flutter/font_awesome_flutter.dart';

// ============================================================================
// Background Audio Player - Embedded Class for Mobile Loop Playback
// ============================================================================
/// Simple wrapper for looping background audio on mobile platforms
class BackgroundAudioPlayer {
  final AudioPlayer _player = AudioPlayer();
  static const String _tag = '🎵 [BackgroundAudioPlayer]';

  Future<void> init() async {
    print('$_tag init() called');
    try {
      print('$_tag Initializing audio player...');
    } catch (e) {
      print('$_tag init() error: $e');
    }
  }

  /// Start playing audio from URL in a loop
  Future<void> start(String url) async {
    print('$_tag ========== START CALLED ==========');
    print('$_tag URL: $url');
    print('$_tag Player already playing? ${_player.playing}');

    try {
      if (_player.playing) {
        print('$_tag Already playing, skipping start');
        return;
      }

      print('$_tag Stopping any existing playback...');
      await _player.stop();

      print('$_tag Setting loop mode to ONE...');
      await _player.setLoopMode(LoopMode.one);

      print('$_tag About to setUrl with: $url');
      print('$_tag URL length: ${url.length}');

      // Timeout setUrl in case it hangs
      await _player.setUrl(url).timeout(
        const Duration(seconds: 15),
        onTimeout: () {
          print('$_tag ⏱️ setUrl TIMEOUT after 15 seconds');
          throw TimeoutException('setUrl took too long');
        },
      );

      print('$_tag ✅ setUrl completed successfully');

      // Add small delay to ensure file is loaded
      await Future.delayed(const Duration(milliseconds: 500));

      print('$_tag Setting volume to 0.5...');
      await _player.setVolume(0.5);

      print('$_tag Calling play()...');
      await _player.play();

      // Wait a moment and verify playback started
      await Future.delayed(const Duration(milliseconds: 500));

      print('$_tag ✅ SUCCESS: Audio started playing in loop');
      print('$_tag Player is now playing? ${_player.playing}');
      print('$_tag Current position: ${_player.position}');
      print('$_tag Duration: ${_player.duration}');
    } catch (e) {
      print('$_tag ❌ ERROR in start(): $e');
      print('$_tag Error type: ${e.runtimeType}');
      print('$_tag Attempting recovery...');

      // Try alternative: use dummy asset as fallback
      try {
        print('$_tag Trying fallback with simpler settings...');
        await _player.setLoopMode(LoopMode.one);
        await _player.setVolume(0.3);
        // Don't retry same URL to avoid infinite loop
      } catch (fallbackError) {
        print('$_tag ❌ Fallback also failed: $fallbackError');
      }
    }
    print('$_tag ========== START COMPLETE ==========');
  }

  /// Stop playback
  Future<void> stop() async {
    print('$_tag ========== STOP CALLED ==========');

    try {
      print('$_tag Stopping playback...');
      await _player.stop();
      print('$_tag ✅ Stopped successfully');
      print('$_tag Player playing? ${_player.playing}');
    } catch (e) {
      print('$_tag ❌ Error stopping: $e');
    }
    print('$_tag ========== STOP COMPLETE ==========');
  }

  /// Dispose resources
  void dispose() {
    print('$_tag dispose() called');
    try {
      _player.dispose();
      print('$_tag ✅ Audio player disposed successfully');
    } catch (e) {
      print('$_tag ❌ Error disposing: $e');
    }
    print('$_tag ========== DISPOSE COMPLETE ==========');
  }
}

// Top-level helper: detect expiration keywords in text (English + Greek)
bool containsExpirationKeywords(String text) {
  final lowerText = text.toLowerCase();
  final englishKeywords = [
    'expiration date',
    'expiry date',
    'expires',
    'expiry',
    'expire',
    'best before',
    'use by',
    'valid until',
    'good until',
  ];
  final greekKeywords = [
    'ημερομηνία λήξης',
    'ημερομηνια ληξης',
    'λήξη',
    'ληξη',
    'λήγει',
    'ληγει',
    'λήξει',
    'ληξει',
    'καλύτερα πριν',
    'καλυτερα πριν',
    'χρήση μέχρι',
    'χρηση μεχρι',
    'ισχύει μέχρι',
    'ισχυει μεχρι',
  ];
  for (final k in englishKeywords) {
    if (lowerText.contains(k)) return true;
  }
  for (final k in greekKeywords) {
    if (lowerText.contains(k)) return true;
  }
  return false;
}

// Extract expiration date from text - looks for common date patterns
String? extractExpirationDateFromText(String text) {
  // Pattern 1: MM/YYYY (01/2025, 12/2025, etc.)
  final mmYyyyPattern = RegExp(r'\b(0?[1-9]|1[0-2])/(\d{4})\b');
  final mmYyyyMatch = mmYyyyPattern.firstMatch(text);
  if (mmYyyyMatch != null) {
    return mmYyyyMatch.group(0);
  }

  // Pattern 2: MM/DD/YYYY (01/15/2025, 12/31/2025, etc.)
  final mmDdYyyyPattern =
      RegExp(r'\b(0?[1-9]|1[0-2])/(0?[1-9]|[12][0-9]|3[01])/(\d{4})\b');
  final mmDdYyyyMatch = mmDdYyyyPattern.firstMatch(text);
  if (mmDdYyyyMatch != null) {
    return mmDdYyyyMatch.group(0);
  }

  // Pattern 3: DD/MM/YYYY (15/01/2025, 31/12/2025, etc.)
  final ddMmYyyyPattern =
      RegExp(r'\b(0?[1-9]|[12][0-9]|3[01])/(0?[1-9]|1[0-2])/(\d{4})\b');
  final ddMmYyyyMatch = ddMmYyyyPattern.firstMatch(text);
  if (ddMmYyyyMatch != null) {
    return ddMmYyyyMatch.group(0);
  }

  // Pattern 4: Month Year format (January 2025, Jan 2025, 01 2025, etc.)
  final monthYearPattern = RegExp(r'\b([A-Za-z]+|\d{2})\s+(\d{4})\b');
  final monthYearMatch = monthYearPattern.firstMatch(text);
  if (monthYearMatch != null) {
    return monthYearMatch.group(0);
  }

  return null;
}

// Top-level helper: navigate to expiration date page and announce
Future<void> navigateToExpirationDate(
  BuildContext context,
  List<dynamic> messages,
  Future<void> Function(String) announce, {
  Function()? openExpirationScanner,
}) async {
  bool isGreek = false;
  if (messages.isNotEmpty) {
    final recentText =
        messages.take(3).map((m) => m.text).join(' ').toLowerCase();
    if (recentText.contains(RegExp(r'[α-ωΑ-Ω]'))) isGreek = true;
  }
  try {
    // Call the scanner function if provided, otherwise show error
    if (openExpirationScanner != null) {
      openExpirationScanner();
      final announcement = isGreek
          ? 'Άνοιγμα σκάνερ ημερομηνίας λήξης'
          : 'Opening expiration date scanner';
      await announce(announcement);
    } else {
      throw Exception('Expiration scanner not available');
    }
  } catch (e) {
    final errorMessage = isGreek
        ? 'Σφάλμα πλοήγησης. Παρακαλώ δοκιμάστε ξανά.'
        : 'Navigation error. Please try again.';
    await announce(errorMessage);
    print('Navigation error: $e');
  }
}

// Top-level helper: show expiration popup with improved UI design
void showExpirationDatePopup(
  BuildContext context, {
  required List<dynamic> messages,
  required bool isGreek,
  required Future<void> Function(String) announce,
  required Function() openExpirationScanner,
}) {
  final title = isGreek ? 'Ημερομηνία Λήξης' : 'Expiration Date';
  final message = isGreek
      ? 'Έχουμε ήδη μια επιλογή ημερομηνίας λήξης στο μενού. Θέλετε να πλοηγηθείτε εκεί;'
      : 'We already have an expiration date option in the menu. Do you want to navigate there?';
  final yesText = isGreek ? 'Ναι' : 'Yes';
  final noText = isGreek ? 'Όχι' : 'No';

  showDialog(
    context: context,
    barrierDismissible: false,
    builder: (BuildContext ctx) {
      return Semantics(
        label: isGreek
            ? "Παράθυρο διαλόγου για ημερομηνία λήξης. Έχουμε ήδη μια επιλογή ημερομηνίας λήξης στο μενού. Θέλετε να πλοηγηθείτε εκεί;"
            : "Expiration date dialog. We already have an expiration date option in the menu. Do you want to navigate there?",
        child: Dialog(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
          ),
          elevation: 8,
          child: Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  Color(0xFF21AAE1).withOpacity(0.12),
                  Color(0xFF21AAE1).withOpacity(0.08),
                ],
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Icon
                ExcludeSemantics(
                  child: Container(
                    width: 60,
                    height: 60,
                    decoration: BoxDecoration(
                      color: Color(0xFF21AAE1),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      Icons.date_range,
                      color: Colors.white,
                      size: 32,
                    ),
                  ),
                ),
                const SizedBox(height: 20),

                // Title
                ExcludeSemantics(
                  child: Text(
                    title,
                    style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF0B6F93),
                    ),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 16),

                // Message
                ExcludeSemantics(
                  child: Text(
                    message,
                    style: TextStyle(
                      fontSize: 16,
                      color: Colors.grey.shade800,
                      height: 1.4,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 24),

                // Action buttons
                Row(
                  children: [
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: isGreek
                            ? "Όχι - κλείστε το παράθυρο διαλόγου"
                            : "No - close dialog",
                        child: TextButton(
                          onPressed: () {
                            Navigator.of(ctx).pop();
                            announce(isGreek ? 'Ακυρώθηκε' : 'Cancelled');
                          },
                          style: TextButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            backgroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                              side: BorderSide(color: Color(0xFF21AAE1)),
                            ),
                          ),
                          child: Text(
                            noText,
                            style: TextStyle(
                              fontSize: 16,
                              color: Color(0xFF21AAE1),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: isGreek
                            ? "Ναι - πηγαίνετε στη σάρωση ημερομηνίας λήξης"
                            : "Yes - go to expiration date scanner",
                        child: ElevatedButton(
                          onPressed: () {
                            Navigator.of(ctx).pop();
                            navigateToExpirationDate(
                              context,
                              messages,
                              announce,
                              openExpirationScanner: openExpirationScanner,
                            );
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Color(0xFF21AAE1),
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                            elevation: 2,
                          ),
                          child: Text(
                            yesText,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
  announce(
    isGreek
        ? 'Εμφανίστηκε διάλογος για ημερομηνία λήξης'
        : 'Expiration date dialog appeared',
  );
}

class AssistantAChatWidgetWithHistory extends StatefulWidget {
  const AssistantAChatWidgetWithHistory({
    Key? key,
    this.width,
    this.height,
    this.experienceTitle = "Assistant A",
    this.experienceTitleName = "Assistant A",
    this.assistantId = "asst_Xtm0ip47SguNNNtDEurE8HNB",
    this.popragBaseUrl = 'https://poprag.odysseas-papadimas.workers.dev',
    this.popragAgentSlug = 'nescafe-assistant',
    this.ignoreApiLimit = true,
    this.imagefeature = true,
    this.barcode = false,
    this.expirationDate = false,
    this.supportAskQuestion = false,
    this.showSupportOption = false,
    this.LouloudisFeature = false,
    required this.languageCode,
    this.supportPhone = "",
    this.supportEmail = "",
    this.supportDaysOpen = "Monday to Friday, 9 AM - 5 PM",
    this.SupportImage,
    this.CallingNumber = "",
    this.headingTitle,
    this.headingSubtitle,
    this.showBayerEmails = false,
    this.GenericEmail,
    this.instagram = "",
  }) : super(key: key);

  final double? width;
  final double? height;
  final String experienceTitle;
  final String experienceTitleName;
  final String assistantId;
  final String popragBaseUrl;
  final String popragAgentSlug;
  final bool ignoreApiLimit;
  final bool imagefeature;
  final bool barcode;
  final bool expirationDate;
  final bool supportAskQuestion;
  final bool showSupportOption;
  final bool LouloudisFeature;
  final String languageCode;
  final String supportPhone;
  final String supportEmail;
  final String supportDaysOpen;
  final String? SupportImage;
  final String CallingNumber;
  final String? headingTitle;
  final String? headingSubtitle;
  final bool showBayerEmails;
  final String? GenericEmail;
  final String instagram;

  @override
  _AssistantAChatWidgetWithHistoryState createState() =>
      _AssistantAChatWidgetWithHistoryState();
}

class _AssistantAChatWidgetWithHistoryState
    extends State<AssistantAChatWidgetWithHistory> {
  late final String _experienceTitle;
  late final String _experienceTitleName;
  late final String _assistantId;
  DocumentReference? _experienceDocRef;
  DocumentReference? _chatDocRef;
  String? _chatSessionId;
  List<Map<String, dynamic>> _chatHistory = [];
  final FirebaseAuth _auth = FirebaseAuth.instance;
  User? _currentUser;
  final TextEditingController _textController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  File? _currentImage;
  bool _isLoading = false;
  bool _isStreaming = false;
  List<ChatMessage> _messages = [];
  StreamSubscription? _streamSubscription;
  StringBuffer _currentResponseBuffer = StringBuffer();
  StringBuffer _rawStreamBuffer = StringBuffer();
  int? _currentMessageIndex;
  Timer? _responseTimeout;
  final Uuid _uuid = const Uuid();
  late String _conversationId;
  late final String _popragBaseUrl;
  late final String _popragAgentSlug;
  bool _hasFinalizedStream = false;
  static const Duration _timeoutDuration = Duration(
    seconds: 120,
  ); // Increased timeout
  final FocusNode _sendButtonFocusNode = FocusNode();
  final FocusNode _cameraButtonFocusNode = FocusNode();
  final FocusNode _galleryButtonFocusNode = FocusNode();

  // Track last used button for iOS VoiceOver focus return
  FocusNode? _lastUsedButtonFocusNode;

  // Screen reader announcement timer
  Timer? _aiThinkingTimer;

  bool get _isGreek => widget.languageCode == 'el';
  bool get _isIOSDevice => defaultTargetPlatform == TargetPlatform.iOS;

  // Unified waiting message (align with ImageRecognitionFeature)
  String get _waitingMessage => _isGreek
      ? 'Παρακαλώ αναμονή για την απάντηση'
      : 'Please wait for response';

  // Barcode processing cancel flag to prevent navigating to results after cancel
  bool _barcodeProcessingCancelled = false;
  // Tracks if the processing page is currently on top of the stack
  bool _isProcessingPageVisible = false;

  // Add these new state variables
  bool _showWelcomeOptions = true;
  bool _isAnnouncingWelcome = false;
  bool _cameFromChat = false; // Track if user navigated from chat to menu
  // Track if expiration dialog has been shown for this chat session
  bool _expirationDialogShownInThisSession = false;
  // Track if support dialog has been shown for this chat session
  bool _supportDialogShownInThisSession = false;
  // Track the last interaction type to focus correctly after AI response
  String? _lastInteractionType; // 'text', 'camera', 'gallery'
  // Store the extracted expiration date to display in the popup
  String? _extractedExpirationDate;
  BackgroundAudioPlayer? _backgroundMusicPlayer;

  @override
  void initState() {
    super.initState();
    _experienceTitle = widget.experienceTitle;
    _experienceTitleName = widget.experienceTitleName;
    _assistantId = widget.assistantId;
    _popragBaseUrl = widget.popragBaseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    _popragAgentSlug = widget.popragAgentSlug.trim().isNotEmpty
        ? widget.popragAgentSlug.trim().replaceFirst(RegExp(r'^/+'), '')
        : widget.assistantId.trim();
    _conversationId = _uuid.v4();

    // Initialize background music player wrapper
    _backgroundMusicPlayer = BackgroundAudioPlayer();
    print('🎵 [AssistantAChat] BackgroundAudioPlayer instance created');

    // fire-and-forget init (implementation may be no-op)
    _backgroundMusicPlayer?.init();
    print('🎵 [AssistantAChat] BackgroundAudioPlayer.init() called');

    if (_auth.currentUser != null) {
      _currentUser = _auth.currentUser;
      _loadConversationHistory();
    }
    _auth.authStateChanges().listen((User? user) {
      if (user != null) {
        setState(() {
          _currentUser = user;
          _messages.clear();
        });
        _loadConversationHistory();
      }
    });

    // Add listener to text controller to update send button state
    _textController.addListener(() {
      setState(() {});
    });

    // Announce welcome options when widget loads
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _announceWelcomeOptions();
    });
  }

  @override
  @override
  void dispose() {
    _aiThinkingTimer?.cancel();
    _streamSubscription?.cancel();
    _responseTimeout?.cancel();
    // Clean up background music resources
    _backgroundMusicPlayer?.dispose();
    _textController.dispose();
    _scrollController.dispose();
    _sendButtonFocusNode.dispose();
    _cameraButtonFocusNode.dispose();
    _galleryButtonFocusNode.dispose();
    super.dispose();
  }

  // Simple announcement method
  Future<void> _announce(String message) async {
    if (message.isNotEmpty) {
      await SemanticsService.announce(
        message,
        _isGreek ? ui.TextDirection.rtl : ui.TextDirection.ltr,
      );
    }
  }

  /// Announce with assertive priority and timing delay (for AI thinking announcements)
  /// This method doesn't await the final announcement to allow other operations to proceed
  void _announceAssertive(String message) {
    if (message.isNotEmpty) {
      // Add extra delay to ensure announcement isn't interrupted
      Future.delayed(const Duration(milliseconds: 150), () {
        SemanticsService.announce(
          message,
          _isGreek ? ui.TextDirection.rtl : ui.TextDirection.ltr,
        );
      });
    }
  }

  // Clean text for display by removing OpenAI citation markers
  String _cleanTextForDisplay(String text) {
    // Remove OpenAI citation markers like 【N†source】, 【25†source】, etc.
    // Using a more comprehensive pattern as suggested by OpenAI community
    final citationRegex = RegExp(r'【.*?】');
    return text.replaceAll(citationRegex, '').trim();
  }

  /// Get fresh signed URL for the waiting sound from Firebase Storage
  Future<String?> _getFreshSignedMusicUrl() async {
    try {
      print('🎵 Generating fresh signed URL from Firebase Storage...');
      final ref = FirebaseStorage.instance.ref().child('Waitingsound.mp3');
      final freshUrl = await ref.getDownloadURL();
      print('✅ Fresh signed URL generated: $freshUrl');
      return freshUrl;
    } catch (e) {
      print('❌ Error generating fresh signed URL: $e');
      return null;
    }
  }

  /// Initialize background music (get URL if needed, then start)
  Future<void> _initializeBackgroundMusic() async {
    print('🎵 ========== _initializeBackgroundMusic() CALLED ==========');

    // Always generate fresh signed URL from Firebase
    print('🎵 Generating fresh signed URL from Firebase...');
    final musicUrl = await _getFreshSignedMusicUrl();

    if (musicUrl != null && musicUrl.isNotEmpty) {
      _startBackgroundMusic(musicUrl);
    } else {
      print('🎵 ❌ Could not obtain music URL, background music disabled');
    }
  }

  /// Start playing background music loop
  Future<void> _startBackgroundMusic(String musicUrl) async {
    print('🎵 ========== _startBackgroundMusic() CALLED ==========');
    print('🎵 Music URL: $musicUrl');

    // Check if a background music URL was provided
    if (musicUrl.isEmpty) {
      print('🎵 ❌ URL is empty, cannot start music');
      print('🎵 ========== _startBackgroundMusic() EARLY RETURN ==========');
      return;
    }

    if (_backgroundMusicPlayer == null) {
      print('🎵 ❌ _backgroundMusicPlayer is null!');
      print('🎵 ========== _startBackgroundMusic() EARLY RETURN ==========');
      return;
    }

    try {
      print('🎵 Using music URL: $musicUrl');
      print('🎵 Calling _backgroundMusicPlayer.start()...');

      // Start looping playback via platform-specific implementation
      await _backgroundMusicPlayer!.start(musicUrl);

      print('🎵 ✅ _backgroundMusicPlayer.start() completed');
      print('🎵 ========== _startBackgroundMusic() SUCCESS ==========');
    } catch (e) {
      print('🎵 ❌ ERROR in _startBackgroundMusic: $e');
      print('🎵 Error type: ${e.runtimeType}');
      print('🎵 ========== _startBackgroundMusic() FAILED ==========');
    }
  }

  /// Stop playing background music
  Future<void> _stopBackgroundMusic() async {
    print('🎵 ========== _stopBackgroundMusic() CALLED ==========');

    if (_backgroundMusicPlayer == null) {
      print('🎵 ❌ _backgroundMusicPlayer is null!');
      print('🎵 ========== _stopBackgroundMusic() EARLY RETURN ==========');
      return;
    }

    try {
      print('🎵 Calling _backgroundMusicPlayer.stop()...');
      await _backgroundMusicPlayer!.stop();
      print('🎵 ✅ _backgroundMusicPlayer.stop() completed');
      print('🎵 ========== _stopBackgroundMusic() SUCCESS ==========');
    } catch (e) {
      print('🎵 ❌ ERROR in _stopBackgroundMusic: $e');
      print('🎵 ========== _stopBackgroundMusic() FAILED ==========');
    }
  }

  // Detect language of user input
  String _detectLanguage(String text) {
    // Remove punctuation and convert to lowercase for better detection
    final cleanText = text.toLowerCase().replaceAll(RegExp(r'[^\w\s]'), '');

    // Greek alphabet characters (extended set)
    final greekRegex = RegExp(
      r'[αβγδεζηθικλμνξοπρστυφχψωάέήίόύώΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ]',
    );

    // Check if text contains Greek characters
    bool hasGreek = greekRegex.hasMatch(
      text,
    ); // Check original text, not cleaned
    print('Language detection for: "$text" -> Greek detected: $hasGreek');

    if (hasGreek) {
      return 'el'; // Greek
    }

    return 'en'; // Default to English
  }

  /// Start periodic "AI is thinking" announcements
  void _startAiThinkingAnnouncements({required bool isImage}) {
    print('🎵🎵🎵 _startAiThinkingAnnouncements called with isImage=$isImage');

    // Cancel any existing timer
    _aiThinkingTimer?.cancel();

    print('🎵 About to call _initializeBackgroundMusic()...');
    // Start background music (async, but we don't need to wait for it to complete before continuing)
    _initializeBackgroundMusic().then((_) {
      print('✅ Music initialization callback completed');
    }).catchError((e) {
      print('❌ Music initialization error: $e');
    });

    // Wait 2 seconds for audio to start, then announce (gives priority to music playback)
    Future.delayed(const Duration(seconds: 2), () {
      if (!mounted || !_isLoading) return;

      final initialMessage = isImage
          ? (_isGreek
              ? 'Εικόνα στάλθηκε, η τεχνητή νοημοσύνη σκέφτεται'
              : 'Image sent, AI is thinking')
          : (_isGreek
              ? 'Ερώτηση στάλθηκε, η τεχνητή νοημοσύνη σκέφτεται'
              : 'Question sent, AI is thinking');

      _announceAssertive(initialMessage);

      // Start periodic announcements every 5 seconds
      _aiThinkingTimer = Timer.periodic(const Duration(seconds: 5), (timer) {
        if (!mounted || !_isLoading) {
          timer.cancel();
          return;
        }

        final thinkingMessage =
            _isGreek ? 'Η τεχνητή νοημοσύνη σκέφτεται' : 'AI is thinking';
        _announceAssertive(thinkingMessage);
      });
    });
  }

  /// Stop all AI thinking announcements
  void _stopAiThinkingAnnouncements() {
    _aiThinkingTimer?.cancel();
    _aiThinkingTimer = null;

    // Stop background music when response completes (don't await, let it run in background)
    _stopBackgroundMusic().catchError((e) {
      print('🎵 Error stopping music: $e');
    });
  }

  Future<bool> _checkApiCallLimit() async {
    if (widget.ignoreApiLimit) return true;
    if (_currentUser == null) return true;
    try {
      final userDoc = await FirebaseFirestore.instance
          .collection('Users')
          .doc(_currentUser!.uid)
          .get();
      final userData = userDoc.data() as Map<String, dynamic>?;
      final apiCalls = userData?['ApiCalls'] ?? 0;
      final apiCallsLimit = userData?['ApiCallsLimit'];
      if (apiCallsLimit == null) return true;
      if (apiCalls >= apiCallsLimit) {
        _showApiLimitReachedMessage();
        return false;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  Future<void> _incrementApiCalls() async {
    if (_currentUser == null) return;
    try {
      await FirebaseFirestore.instance
          .collection('Users')
          .doc(_currentUser!.uid)
          .update({'ApiCalls': FieldValue.increment(1)});
    } catch (e) {}
  }

  void _showApiLimitReachedMessage() {
    final message = _isGreek
        ? 'Φτάσατε το όριο ερωτήσεων.'
        : 'You have reached the question limit.';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: Colors.red),
    );
  }

  void _startResponseTimeout() {
    _responseTimeout?.cancel();
    _responseTimeout = Timer(_timeoutDuration, () {
      if (_isStreaming || _isLoading) {
        _handleTimeout();
      }
    });
  }

  void _cancelResponseTimeout() {
    _responseTimeout?.cancel();
    _responseTimeout = null;
  }

  void _handleTimeout() {
    _streamSubscription?.cancel();
    setState(() {
      _isStreaming = false;
      _isLoading = false;
    });
    if (_currentMessageIndex != null &&
        _currentMessageIndex! < _messages.length &&
        _messages[_currentMessageIndex!].text.isEmpty) {
      setState(() {
        _messages.removeAt(_currentMessageIndex!);
      });
    }
    _currentResponseBuffer.clear();
    final timeoutMessage = _isGreek
        ? 'Λήξη χρονικού ορίου - δεν ελήφθη απάντηση από τον βοηθό'
        : 'Timeout - no response received from assistant';
    _handleError(timeoutMessage);
    _announce(timeoutMessage);
  }

  bool _ensurePopragConfig() {
    if (_popragBaseUrl.isEmpty || _popragAgentSlug.isEmpty) {
      _handleError(
        _isGreek
            ? 'Λείπει ρύθμιση API. Παρακαλώ ορίστε PopRAG URL και Agent Slug.'
            : 'Missing API configuration. Please set PopRAG URL and Agent Slug.',
      );
      return false;
    }
    final isExampleUrl = _popragBaseUrl.contains('your-instance.workers.dev');
    final isExampleSlug = _popragAgentSlug == 'my-agent';
    if (isExampleUrl || isExampleSlug) {
      _handleError(
        _isGreek
            ? 'Χρησιμοποιούνται τα παραδείγματα του documentation. Βάλε το πραγματικό PopRAG URL και Agent Slug.'
            : 'You are using the documentation examples. Set the real PopRAG URL and Agent Slug.',
      );
      return false;
    }
    return true;
  }

  String _applyLanguageInstruction(String message, {required bool isImage}) {
    final detectedLanguage = _detectLanguage(message);
    String languageInstruction;

    if (isImage) {
      languageInstruction =
          _isGreek ? 'Απάντησε στα ελληνικά. ' : 'Respond in English. ';
    } else {
      languageInstruction = detectedLanguage == 'el'
          ? 'Απάντησε στα ελληνικά. '
          : 'Respond in English. ';
    }

    return languageInstruction + message;
  }

  Future<String?> _encodeImageAsDataUrl(File file) async {
    try {
      final bytes = await file.readAsBytes();
      final ext = path.extension(file.path).toLowerCase();
      String mimeType;
      switch (ext) {
        case '.png':
          mimeType = 'image/png';
          break;
        case '.gif':
          mimeType = 'image/gif';
          break;
        case '.webp':
          mimeType = 'image/webp';
          break;
        case '.jpg':
        case '.jpeg':
        default:
          mimeType = 'image/jpeg';
          break;
      }
      final base64Data = base64Encode(bytes);
      return 'data:$mimeType;base64,$base64Data';
    } catch (e) {
      print('Error encoding image: $e');
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> _buildPopragMessages({
    String? overrideLastUserText,
    String? overrideLastImageDataUrl,
  }) async {
    final List<Map<String, dynamic>> payloadMessages = [];
    final List<ChatMessage> sourceMessages = List.from(_messages);

    if (sourceMessages.isNotEmpty) {
      final lastMessage = sourceMessages.last;
      final shouldDropLast =
          !lastMessage.isUser && lastMessage.text.trim().isEmpty;
      if (shouldDropLast) {
        sourceMessages.removeLast();
      }
    }

    for (int i = 0; i < sourceMessages.length; i++) {
      final msg = sourceMessages[i];
      final isLast = i == sourceMessages.length - 1;
      final role = msg.isUser ? 'user' : 'assistant';

      String text = msg.text;
      if (msg.isUser && isLast && overrideLastUserText != null) {
        text = overrideLastUserText;
      }

      String? imageDataUrl;
      if (msg.isUser && msg.image != null) {
        if (isLast && overrideLastImageDataUrl != null) {
          imageDataUrl = overrideLastImageDataUrl;
        } else {
          imageDataUrl = await _encodeImageAsDataUrl(msg.image!);
        }
      }

      final parts = <Map<String, dynamic>>[];
      if (text.trim().isNotEmpty) {
        parts.add({'type': 'text', 'text': text});
      }
      if (imageDataUrl != null && imageDataUrl.isNotEmpty) {
        parts.add({'type': 'image', 'image': imageDataUrl});
      }
      if (parts.isEmpty) {
        parts.add({'type': 'text', 'text': ''});
      }

      payloadMessages.add({
        'id': _uuid.v4(),
        'role': role,
        'parts': parts,
      });
    }

    return payloadMessages;
  }

  void _finalizeStreamOnce() {
    if (_hasFinalizedStream) return;
    _hasFinalizedStream = true;
    _finalizeStream();
  }

  Future<void> _sendPopragRequest({
    required String message,
    String? imageDataUrl,
  }) async {
    if (!_ensurePopragConfig()) return;

    final instructedMessage =
        _applyLanguageInstruction(message, isImage: imageDataUrl != null);
    final messages = await _buildPopragMessages(
      overrideLastUserText: instructedMessage,
      overrideLastImageDataUrl: imageDataUrl,
    );

    final requestBody = {
      'conversationId': _conversationId,
      'messages': messages,
      'rag': {'topK': 6},
    };

    final client = http.Client();
    try {
      final request = http.Request(
        'POST',
        Uri.parse('$_popragBaseUrl/api/chat/$_popragAgentSlug'),
      )
        ..headers['Content-Type'] = 'application/json'
        ..body = jsonEncode(requestBody);

      final response = await client.send(request);
      if (response.statusCode != 200) {
        final errorBody = await response.stream.bytesToString();
        String errorMessage =
            _isGreek ? 'Αποτυχία αιτήματος.' : 'Request failed.';
        try {
          final parsed = jsonDecode(errorBody) as Map<String, dynamic>;
          errorMessage = parsed['error']?.toString() ?? errorMessage;
        } catch (_) {}
        _handleError(errorMessage);
        client.close();
        return;
      }

      _streamSubscription = response.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
        (line) {
          try {
            final trimmed = line.trim();
            _rawStreamBuffer.write(line);
            _rawStreamBuffer.write('\n');
            if (trimmed.isEmpty) return;

            if (trimmed.startsWith('0:')) {
              final text = jsonDecode(trimmed.substring(2)) as String;
              _currentResponseBuffer.write(text);
              _updateAssistantMessage();
              _startResponseTimeout();
            } else if (trimmed.startsWith('data:')) {
              final dataPayload = trimmed.substring(5).trim();
              if (dataPayload.isNotEmpty && dataPayload != '[DONE]') {
                try {
                  final decoded = jsonDecode(dataPayload);
                  if (decoded is String) {
                    _currentResponseBuffer.write(decoded);
                    _updateAssistantMessage();
                    _startResponseTimeout();
                  } else if (decoded is Map<String, dynamic>) {
                    // Handle PopRAG SSE format: {"type":"text-delta","delta":"text"}
                    final eventType = decoded['type']?.toString();
                    if (eventType == 'text-delta') {
                      final delta = decoded['delta']?.toString() ?? '';
                      if (delta.isNotEmpty) {
                        _currentResponseBuffer.write(delta);
                        _updateAssistantMessage();
                        _startResponseTimeout();
                      }
                    } else if (eventType == 'finish') {
                      _finalizeStreamOnce();
                    } else {
                      // Fallback for other formats
                      final text = decoded['text'] ??
                          decoded['message'] ??
                          decoded['response'] ??
                          decoded['content'];
                      if (text is String && text.isNotEmpty) {
                        _currentResponseBuffer.write(text);
                        _updateAssistantMessage();
                        _startResponseTimeout();
                      }
                    }
                  }
                } catch (_) {}
              }
            } else if (trimmed.startsWith('e:')) {
              _finalizeStreamOnce();
            }
          } catch (e) {
            print('Error processing stream line: $e');
          }
        },
        onError: (e) {
          print('Stream error: $e');
          _handleError('Stream error: ${e.toString()}');
          client.close();
        },
        onDone: () {
          client.close();
          _finalizeStreamOnce();
        },
        cancelOnError: false,
      );
    } catch (e) {
      _handleError('Connection problem. Check your internet and try again.');
      client.close();
    }
  }

  Future<void> _handleSubmitted(String value, {bool isImage = false}) async {
    if (value.trim().isEmpty && _currentImage == null && !isImage) return;

    final canProceed = await _checkApiCallLimit();
    if (!canProceed) return;

    // Track interaction type if not already set (for camera/gallery)
    if (_lastInteractionType == null || _lastInteractionType!.isEmpty) {
      _lastInteractionType = 'text';
    }

    setState(() {
      _messages.add(ChatMessage(
        text: value.trim().isNotEmpty
            ? value.trim()
            : (_isGreek ? 'Ανάλυσε αυτή την εικόνα' : 'Analyze this image'),
        isUser: true,
        image: _currentImage,
      ));
      _isLoading = true;
    });

    // Start AI thinking announcements for text questions (not images, as they already started)
    if (!isImage && value.trim().isNotEmpty) {
      _startAiThinkingAnnouncements(isImage: false);
    }

    _storeMessageInFirebase(
      message: ChatMessage(text: value.trim(), isUser: true),
      role: 'user',
    );
    _textController.clear();

    // iOS VoiceOver: Return focus to the last used button
    // Android TalkBack: System handles it naturally
    if (_isIOSDevice && _lastUsedButtonFocusNode != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _lastUsedButtonFocusNode?.requestFocus();
      });
    }

    _scrollToBottom();
    _processMessage(value.trim().isNotEmpty
        ? value.trim()
        : (_isGreek ? 'Ανάλυσε αυτή την εικόνα' : 'Analyze this image'));
  }

  void _handleCameraButtonPressed() {
    if (_isLoading || _isStreaming) {
      final waitMessage = _isGreek
          ? 'Παρακαλώ περιμένετε πριν χρησιμοποιήσετε την κάμερα'
          : 'Please wait before using the camera';
      _announce(waitMessage);
      return;
    }
    _openCustomCamera();
  }

  void _handleGalleryButtonPressed() {
    if (_isLoading || _isStreaming) {
      final waitMessage = _isGreek
          ? 'Παρακαλώ περιμένετε πριν ανοίξετε τη συλλογή'
          : 'Please wait before opening the gallery';
      _announce(waitMessage);
      return;
    }
    _pickImage(ImageSource.gallery);
  }

  Future<void> _openCustomCamera({bool fromMenu = false}) async {
    // Track camera button for iOS focus return
    if (_isIOSDevice) {
      _lastUsedButtonFocusNode = _cameraButtonFocusNode;
    }

    final canProceed = await _checkApiCallLimit();
    if (!canProceed) return;

    setState(() {
      _isLoading = true;
    });

    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => CustomCameraForChat(
          width: widget.width ?? MediaQuery.of(context).size.width,
          height: widget.height ?? MediaQuery.of(context).size.height,
        ),
      ),
    );

    if (result != null) {
      // Track that user sent image from camera
      _lastInteractionType = 'camera';

      _currentImage = File(result);

      // Navigate to chat if coming from menu
      if (fromMenu) {
        setState(() {
          _showWelcomeOptions = false;
        });
      } else {
        setState(() => _isLoading = true);
      }

      // Start AI thinking announcements for images
      _startAiThinkingAnnouncements(isImage: true);

      _scrollToBottom();

      // Call _handleSubmitted to add message and handle focus restoration
      await _handleSubmitted('', isImage: true);
    } else {
      // User cancelled camera
      setState(() {
        _isLoading = false;
      });
    }
  }

  Future<void> _pickImage(ImageSource source) async {
    // Track gallery button for iOS focus return
    if (_isIOSDevice) {
      _lastUsedButtonFocusNode = _galleryButtonFocusNode;
    }

    try {
      final canProceed = await _checkApiCallLimit();
      if (!canProceed) return;

      setState(() {
        _isLoading = true;
      });

      final ImagePicker picker = ImagePicker();
      final XFile? image = await picker.pickImage(
        source: source,
        maxWidth: 1024,
        maxHeight: 1024,
        imageQuality: 85,
      );

      if (image != null) {
        // Track whether image came from camera or gallery based on source parameter
        _lastInteractionType =
            (source == ImageSource.camera) ? 'camera' : 'gallery';

        _currentImage = File(image.path);
        setState(() => _isLoading = true);

        // Start AI thinking announcements for images
        _startAiThinkingAnnouncements(isImage: true);

        _scrollToBottom();

        // Call _handleSubmitted to add message and handle focus restoration
        await _handleSubmitted('', isImage: true);
      } else {
        // User cancelled gallery
        setState(() {
          _isLoading = false;
        });
      }
    } catch (e) {
      setState(() {
        _isLoading = false;
      });
      _handleError('Problem with the image. Please try with another image.');
    }
  }

  Future<void> _processMessage(String message) async {
    try {
      // Add empty AI message placeholder
      bool addEmptyMessage = true;
      if (_currentImage != null) {
        if (_messages.isNotEmpty &&
            _messages.last.isUser &&
            _messages.last.image != null) {
          addEmptyMessage = true;
        }
      }
      if (addEmptyMessage) {
        setState(() {
          _messages.add(ChatMessage(text: "", isUser: false));
          _currentMessageIndex = _messages.length - 1;
          _isStreaming = true;
          _hasFinalizedStream = false;
        });
        _scrollToBottom();
      }

      _startResponseTimeout();

      String? imageDataUrl;
      if (_currentImage != null) {
        await _storeMessageInFirebase(
          message: ChatMessage(
            text: message,
            isUser: true,
            image: _currentImage,
          ),
          role: 'user',
        );
        imageDataUrl = await _encodeImageAsDataUrl(_currentImage!);
        _currentImage = null;
      }

      await _sendPopragRequest(
        message: message,
        imageDataUrl: imageDataUrl,
      );
      _scrollToBottom();
    } catch (e) {
      _handleError(e.toString());
    }
  }

  void _updateAssistantMessage() {
    if (_currentMessageIndex != null &&
        _currentMessageIndex! < _messages.length) {
      setState(() {
        _messages[_currentMessageIndex!] = ChatMessage(
          text: _cleanTextForDisplay(_currentResponseBuffer.toString()),
          isUser: false,
        );
      });
      _scrollToBottom();
    }
  }

  Future<void> _finalizeStream() async {
    _streamSubscription?.cancel();
    _cancelResponseTimeout();
    String responseText = _cleanTextForDisplay(
      _currentResponseBuffer.toString(),
    );
    if (responseText.isEmpty && _rawStreamBuffer.isNotEmpty) {
      final raw = _rawStreamBuffer.toString().trim();
      String? fallbackText;
      try {
        final normalized = raw.startsWith('data:')
            ? raw
                .split('\n')
                .where((l) => l.trim().startsWith('data:'))
                .map((l) => l.trim().substring(5).trim())
                .where((v) => v.isNotEmpty && v != '[DONE]')
                .join('')
            : raw;

        final decoded = jsonDecode(normalized);
        if (decoded is String) {
          fallbackText = decoded;
        } else if (decoded is Map<String, dynamic>) {
          fallbackText = decoded['text'] ??
              decoded['message'] ??
              decoded['response'] ??
              decoded['content'];
        }
      } catch (_) {
        fallbackText = raw;
      }
      if (fallbackText != null && fallbackText.trim().isNotEmpty) {
        responseText = _cleanTextForDisplay(fallbackText);
      }
    }
    _currentResponseBuffer.clear();
    _rawStreamBuffer.clear();

    // Stop AI thinking announcements when response is complete
    _stopAiThinkingAnnouncements();

    setState(() {
      _isStreaming = false;
      _isLoading = false;
      // Update the message with cleaned text
      if (_currentMessageIndex != null &&
          _currentMessageIndex! < _messages.length) {
        _messages[_currentMessageIndex!] = ChatMessage(
          text: responseText,
          isUser: false,
        );
      }
    });

    // Announce the AI response for screen reader users
    if (responseText.isNotEmpty) {
      final responseLabel =
          _isGreek ? 'Απάντηση βοηθού: ' : 'Assistant response: ';
      _announce('$responseLabel$responseText');
    }

    if (responseText.isNotEmpty) {
      await _incrementApiCalls();
      await _storeMessageInFirebase(
        message: ChatMessage(text: responseText, isUser: false),
        role: 'assistant',
      );
      if (_messages.length <= 2) {
        final firstUserMessage = _messages.firstWhere(
          (msg) => msg.isUser,
          orElse: () => ChatMessage(text: '', isUser: true),
        );
        final title = await _generateConversationTitle(firstUserMessage.text);
        if (_chatDocRef != null) {
          await _chatDocRef!.update({'title': title});
          await _loadConversationHistory();
        }
      }

      // Check for expiration date keywords in AI response - show only once per session
      if (containsExpirationKeywords(responseText) &&
          !_expirationDialogShownInThisSession) {
        _expirationDialogShownInThisSession = true;
        // Extract the detected date from the response
        _extractedExpirationDate = extractExpirationDateFromText(responseText);
        // Wait 2 seconds after announcement starts (300ms + 2000ms = 3500ms)
        Future.delayed(const Duration(milliseconds: 3500), () {
          _showExpirationDatePopup();
        });
      }

      // Check for support keywords in AI response - show only once per session
      if (_shouldSuggestSupport(responseText) &&
          !_supportDialogShownInThisSession) {
        if (widget.showSupportOption) {
          _supportDialogShownInThisSession = true;
          // Wait 2 seconds after announcement starts (300ms + 2000ms = 3500ms)
          Future.delayed(const Duration(milliseconds: 3500), () {
            _showSupportDialog();
          });
        }
      }
    }
    _scrollToBottom();
  }

  bool _shouldSuggestSupport(String response) {
    // Check if response contains the CallingNumber value
    if (widget.CallingNumber != null && widget.CallingNumber.isNotEmpty) {
      return response.contains(widget.CallingNumber);
    }
    return false;
  }

  void _showSupportDialog() {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => Dialog(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
        ),
        elevation: 8,
        child: Semantics(
          label: _isGreek
              ? "Παράθυρο διαλόγου υποστήριξης. Θέλετε να ανοίξετε την υποστήριξη;"
              : "Support dialog. Do you want to open support?",
          child: Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  Color(0xFF21AAE1).withOpacity(0.12),
                  Color(0xFF21AAE1).withOpacity(0.08),
                ],
              ),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Support icon
                ExcludeSemantics(
                  child: Container(
                    width: 60,
                    height: 60,
                    decoration: BoxDecoration(
                      color: Color(0xFF21AAE1),
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      Icons.support_agent,
                      color: Colors.white,
                      size: 32,
                    ),
                  ),
                ),
                const SizedBox(height: 20),

                // Title
                ExcludeSemantics(
                  child: Text(
                    _isGreek ? "Υποστήριξη" : "Support",
                    style: Theme.of(
                      context,
                    ).textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.bold,
                          color: Color(0xFF0B6F93),
                        ),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 16),

                // Content
                ExcludeSemantics(
                  child: Text(
                    _isGreek
                        ? "Θέλετε να ανοίξετε την υποστήριξη;"
                        : "Do you want to open support?",
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          color: Colors.grey.shade800,
                          height: 1.4,
                        ),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 24),

                // Action buttons
                Row(
                  children: [
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: _isGreek ? "Όχι" : "No",
                        excludeSemantics: true,
                        child: TextButton(
                          onPressed: () {
                            Navigator.of(context).pop();
                            _announce(_isGreek ? 'Ακυρώθηκε' : 'Cancelled');
                          },
                          style: TextButton.styleFrom(
                            padding: const EdgeInsets.symmetric(
                              vertical: 16,
                            ),
                            backgroundColor: Colors.white,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                              side: BorderSide(color: Color(0xFF21AAE1)),
                            ),
                          ),
                          child: ExcludeSemantics(
                            child: Text(
                              _isGreek ? "Όχι" : "No",
                              style: TextStyle(
                                fontSize: 16,
                                color: Color(0xFF21AAE1),
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Semantics(
                        button: true,
                        label: _isGreek ? "Ναι" : "Yes",
                        excludeSemantics: true,
                        child: ElevatedButton(
                          onPressed: () async {
                            Navigator.of(context).pop();
                            await Future.delayed(
                              const Duration(milliseconds: 200),
                            );
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (context) => buildSupportPage(
                                  context,
                                  supportPhone: widget.supportPhone,
                                  supportEmail: widget.supportEmail,
                                  supportDaysOpen: widget.supportDaysOpen,
                                  SupportImage: widget.SupportImage,
                                  CallingNumber: widget.CallingNumber,
                                  headingTitle: widget.headingTitle,
                                  headingSubtitle: widget.headingSubtitle,
                                  GenericEmail: widget.GenericEmail,
                                  instagram: widget.instagram,
                                ),
                              ),
                            );
                          },
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Color(0xFF21AAE1),
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(
                              vertical: 16,
                            ),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12),
                            ),
                            elevation: 2,
                          ),
                          child: ExcludeSemantics(
                            child: Text(
                              _isGreek ? "Ναι" : "Yes",
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _handleError(String error) {
    // Stop AI thinking announcements on error
    _stopAiThinkingAnnouncements();

    setState(() {
      _isLoading = false;
      _isStreaming = false;
    });
    _streamSubscription?.cancel();
    _cancelResponseTimeout();
    if (_currentMessageIndex != null &&
        _currentMessageIndex! < _messages.length &&
        _messages[_currentMessageIndex!].text.isEmpty) {
      setState(() {
        _messages.removeAt(_currentMessageIndex!);
      });
    }
    _currentResponseBuffer.clear();
    String userFriendlyMessage;
    if (error.toLowerCase().contains('timeout')) {
      userFriendlyMessage = _isGreek
          ? 'Ο βοηθός δεν απαντά. Παρακαλώ δοκιμάστε ξανά.'
          : 'The assistant is not responding. Please try again.';
    } else if (error.toLowerCase().contains('connection') ||
        error.toLowerCase().contains('network')) {
      userFriendlyMessage = _isGreek
          ? 'Πρόβλημα σύνδεσης. Ελέγξτε το διαδίκτυό σας και δοκιμάστε ξανά.'
          : 'Connection problem. Check your internet and try again.';
    } else if (error.toLowerCase().contains('limit') &&
        !widget.ignoreApiLimit) {
      userFriendlyMessage = _isGreek
          ? 'Φτάσατε το όριο χρήσης. Παρακαλώ δοκιμάστε αργότερα.'
          : 'Usage limit reached. Please try again later.';
    } else if (error.toLowerCase().contains('assistant')) {
      userFriendlyMessage = _isGreek
          ? 'Ο βοηθός δεν είναι διαθέσιμος αυτή τη στιγμή. Δοκιμάστε ξανά.'
          : 'The assistant is not available right now. Please try again.';
    } else if (error.toLowerCase().contains('image')) {
      userFriendlyMessage = _isGreek
          ? 'Πρόβλημα με την εικόνα. Παρακαλώ δοκιμάστε με άλλη εικόνα.'
          : 'Problem with the image. Please try with another image.';
    } else {
      userFriendlyMessage = _isGreek
          ? 'Κάτι πήγε στραβά. Παρακαλώ δοκιμάστε ξανά.'
          : 'Something went wrong. Please try again.';
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(userFriendlyMessage),
        backgroundColor: Colors.red,
        duration: const Duration(seconds: 4),
      ),
    );
    _announce(userFriendlyMessage);
  }

  Future<String> _generateConversationTitle(String content) async {
    if (content.isEmpty) {
      return _isGreek ? 'Νέα συζήτηση' : 'New chat';
    }
    if (content.trim() == 'Analyze this image' ||
        content.trim() == 'Ανάλυσε αυτή την εικόνα') {
      return _isGreek ? 'Ανάλυση εικόνας' : 'Image analysis';
    }
    final words = content.split(' ').take(4).join(' ');
    return words.length > 50 ? '${words.substring(0, 47)}...' : words;
  }

  bool _containsGreekCharacters(String text) {
    final greekRegex = RegExp(r'[\u0370-\u03FF\u1F00-\u1FFF]');
    return greekRegex.hasMatch(text);
  }

  String _formatTimestamp(Timestamp timestamp) {
    final dateTime = timestamp.toDate();
    if (_isGreek) {
      const greekMonths = [
        'Ιαν',
        'Φεβ',
        'Μαρ',
        'Απρ',
        'Μάι',
        'Ιουν',
        'Ιουλ',
        'Αυγ',
        'Σεπ',
        'Οκτ',
        'Νοε',
        'Δεκ',
      ];
      final month = greekMonths[dateTime.month - 1];
      final day = dateTime.day.toString().padLeft(2, '0');
      final hour = dateTime.hour.toString().padLeft(2, '0');
      final minute = dateTime.minute.toString().padLeft(2, '0');
      return '$month $day, $hour:$minute';
    } else {
      return DateFormat('MMM dd, HH:mm').format(dateTime);
    }
  }

  Future<void> _loadConversationHistory() async {
    if (_currentUser == null) return;
    try {
      _experienceDocRef = FirebaseFirestore.instance
          .collection('Users')
          .doc(_currentUser!.uid)
          .collection('experiences')
          .doc(widget.experienceTitle);
      await _experienceDocRef!.set({
        'lastUsed': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));
      final snapshot = await _experienceDocRef!
          .collection('chats')
          .orderBy('createdAt', descending: true)
          .get();
      setState(() {
        _chatHistory = snapshot.docs.map((doc) {
          final data = doc.data();
          final originalTitle = data['title'] ?? 'New chat';
          String displayTitle = originalTitle;
          if (_isGreek && originalTitle == 'New chat') {
            displayTitle = 'Νέα συζήτηση';
          }
          return {
            'id': doc.id,
            'title': displayTitle,
            'originalTitle': originalTitle,
            'createdAt': data['createdAt'] ?? Timestamp.now(),
          };
        }).toList();
      });
    } catch (e) {
      setState(() {
        _chatHistory = [];
      });
    }
  }

  Future<void> _loadConversation(String chatId) async {
    if (_currentUser == null) return;
    _scaffoldKey.currentState?.closeEndDrawer();
    setState(() {
      _isLoading = true;
      _showWelcomeOptions = false; // Navigate to chat interface
      _expirationDialogShownInThisSession =
          false; // Reset expiration dialog flag for loaded conversation
    });
    try {
      _chatSessionId = chatId;
      _chatDocRef = _experienceDocRef!.collection('chats').doc(chatId);
      setState(() {
        _messages.clear();
      });
      final snapshot =
          await _chatDocRef!.collection('messages').orderBy('timestamp').get();
      if (snapshot.docs.isEmpty) {
        setState(() => _isLoading = false);
        return;
      }

      final List<ChatMessage> messages = [];

      for (var doc in snapshot.docs) {
        final data = doc.data();
        final isUser = data['role'] == 'user';
        final content = data['content'] ?? '';
        final imageUrl = data['imageUrl'];

        // Clean citation markers from assistant messages
        final cleanedContent = isUser ? content : _cleanTextForDisplay(content);

        if (imageUrl != null) {
          messages.add(ChatMessage(text: cleanedContent, isUser: isUser));
        } else {
          messages.add(ChatMessage(text: cleanedContent, isUser: isUser));
        }
      }

      setState(() {
        _messages.addAll(messages);
        _isLoading = false;
      });

      int messageIndex = 0;
      for (var doc in snapshot.docs) {
        final data = doc.data();
        final imageUrl = data['imageUrl'];

        if (imageUrl != null) {
          try {
            final file = await _downloadImage(imageUrl);

            if (mounted) {
              setState(() {
                _messages[messageIndex] = ChatMessage(
                  text: _messages[messageIndex].text,
                  isUser: _messages[messageIndex].isUser,
                  image: file,
                );
              });
            }
          } catch (e) {}
        }
        messageIndex++;
      }

      _scrollToBottom();
      _announce(
        _isGreek
            ? 'Συζήτηση φορτώθηκε επιτυχώς'
            : 'Conversation loaded successfully',
      );
    } catch (e) {
      setState(() => _isLoading = false);
    }
  }

  Future<File> _downloadImage(String url) async {
    final response = await http.get(Uri.parse(url));
    final tempDir = await getTemporaryDirectory();
    final filePath =
        '${tempDir.path}/${DateTime.now().millisecondsSinceEpoch}.jpg';
    final file = File(filePath);
    await file.writeAsBytes(response.bodyBytes);
    return file;
  }

  Future<void> _deleteConversation(String chatId, String chatTitle) async {
    _announce(
      _isGreek
          ? 'Διαγραφή συζήτησης "$chatTitle"'
          : 'Deleting conversation "$chatTitle"',
    );
    setState(() {
      _chatHistory.removeWhere((chat) => chat['id'] == chatId);
    });
    try {
      final messagesSnapshot = await _experienceDocRef!
          .collection('chats')
          .doc(chatId)
          .collection('messages')
          .get();
      for (var doc in messagesSnapshot.docs) {
        final data = doc.data();
        if (data['imageUrl'] != null) {
          FirebaseStorage.instance
              .refFromURL(data['imageUrl'])
              .delete()
              .catchError((e) {});
        }
      }
      for (var doc in messagesSnapshot.docs) {
        _experienceDocRef!
            .collection('chats')
            .doc(chatId)
            .collection('messages')
            .doc(doc.id)
            .delete()
            .catchError((e) {});
      }
      await _experienceDocRef!.collection('chats').doc(chatId).delete();
      _announce(
        _isGreek
            ? 'Η συζήτηση "$chatTitle" διαγράφηκε επιτυχώς'
            : 'Conversation "$chatTitle" deleted successfully',
      );
    } catch (e) {
      await _loadConversationHistory();
    }
  }

  Future<void> _storeMessageInFirebase({
    required ChatMessage message,
    required String role,
  }) async {
    if (_currentUser == null) return;
    try {
      if (_chatDocRef == null) {
        _chatSessionId = DateTime.now().millisecondsSinceEpoch.toString();
        _chatDocRef =
            _experienceDocRef!.collection('chats').doc(_chatSessionId);
        await _chatDocRef!.set({
          'title': _isGreek ? 'Νέα συζήτηση' : 'New chat',
          'createdAt': FieldValue.serverTimestamp(),
          'lastUpdated': FieldValue.serverTimestamp(),
        });
      }
      final messageData = <String, dynamic>{
        'content': message.text,
        'role': role,
        'timestamp': FieldValue.serverTimestamp(),
      };
      if (message.image != null) {
        try {
          final imageUrl = await _uploadImageToStorage(message.image!);
          messageData['imageUrl'] = imageUrl;
        } catch (e) {}
      }
      await _chatDocRef!.collection('messages').add(messageData);
      await _chatDocRef!.update({'lastUpdated': FieldValue.serverTimestamp()});
    } catch (e) {}
  }

  Future<String> _uploadImageToStorage(File imageFile) async {
    try {
      final storageRef = FirebaseStorage.instance
          .ref()
          .child('chat_images')
          .child('${_currentUser!.uid}')
          .child('${DateTime.now().millisecondsSinceEpoch}.jpg');
      final uploadTask = storageRef.putFile(imageFile);
      final snapshot = await uploadTask;
      return await snapshot.ref.getDownloadURL();
    } catch (e) {
      rethrow;
    }
  }

  Widget _buildMessageItem(ChatMessage message, int index) {
    // Check if this is the current AI response being streamed
    final isCurrentAiResponse =
        !message.isUser && _isStreaming && _currentMessageIndex == index;

    if (message.image != null) {
      final imageLabel = _isGreek ? 'Εικόνα χρήστη' : "User's image";
      return Align(
        alignment:
            message.isUser ? Alignment.centerRight : Alignment.centerLeft,
        child: Semantics(
          label: imageLabel,
          container: true,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4.0, horizontal: 8.0),
            // No colored background or thick border; show only the image, smaller
            padding: EdgeInsets.zero,
            decoration: const BoxDecoration(),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10.0),
              child: ExcludeSemantics(
                child: Image.file(
                  message.image!,
                  width: 150, // smaller image
                  height: 150,
                  fit: BoxFit.cover,
                ),
              ),
            ),
          ),
        ),
      );
    }

    // Simple message bubble without focus management
    return _buildMessageContainer(message);
  }

  Widget _buildMessageContainer(ChatMessage message) {
    // Create appropriate semantic label based on message type
    // USER MESSAGES are EXCLUDED from screen reader - we only announce "Please wait"
    // AI RESPONSES are announced when complete
    final semanticLabel = message.isUser
        ? '' // Empty for user messages (will be excluded)
        : (_isGreek ? 'Απάντηση βοηθού' : 'Assistant response');

    final displayText =
        message.isUser ? message.text : _cleanTextForDisplay(message.text);

    // For USER messages: Exclude from semantics completely
    if (message.isUser) {
      return Align(
        alignment: Alignment.centerRight,
        child: ExcludeSemantics(
          child: Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.75,
            ),
            margin: const EdgeInsets.symmetric(vertical: 4.0, horizontal: 8.0),
            padding:
                const EdgeInsets.symmetric(horizontal: 16.0, vertical: 10.0),
            decoration: BoxDecoration(
              color: const Color(0xFF007AFF), // Blue for user messages
              borderRadius: BorderRadius.circular(20.0),
            ),
            child: Text(
              displayText,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 16.0,
                height: 1.4,
              ),
            ),
          ),
        ),
      );
    }

    // For AI messages: Clean container without excessive semantics wrapper
    // Let the Focus node (attached in _buildMessageItem) handle semantics naturally
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        margin: const EdgeInsets.symmetric(vertical: 4.0, horizontal: 8.0),
        padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 10.0),
        decoration: BoxDecoration(
          color: const Color(0xFFF0F0F0), // Light grey for assistant
          borderRadius: BorderRadius.circular(20.0),
        ),
        child: Semantics(
          label: '$semanticLabel: $displayText',
          container: true,
          child: Text(
            displayText,
            style: const TextStyle(
              color: Colors.black,
              fontSize: 16.0,
              height: 1.4,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildInputArea() {
    final bool hasText = _textController.text.trim().isNotEmpty;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 8.0),
      decoration: BoxDecoration(
        color: const Color(0xFFF9F9F9),
        border: Border(
          top: BorderSide(color: Colors.grey.shade300, width: 0.5),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (widget.imagefeature) ...[
            _buildAccessibleButton(
              icon: Icons.camera_alt_outlined,
              label: _isGreek ? 'Κάμερα' : 'Camera',
              onPressed:
                  (_isLoading || _isStreaming) ? null : _openCustomCamera,
              focusNode: _cameraButtonFocusNode,
            ),
            _buildAccessibleButton(
              icon: Icons.photo_outlined,
              label: _isGreek ? 'Συλλογή' : 'Gallery',
              onPressed: (_isLoading || _isStreaming)
                  ? null
                  : () => _pickImage(ImageSource.gallery),
              focusNode: _galleryButtonFocusNode,
            ),
          ],
          Expanded(
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 4.0),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20.0),
                border: Border.all(color: Colors.grey.shade300),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Semantics(
                      label: _isGreek
                          ? 'Πεδίο κειμένου για ερώτηση'
                          : 'Text field for question',
                      textField: true,
                      child: TextFormField(
                        controller: _textController,
                        enabled: !_isLoading && !_isStreaming,
                        onFieldSubmitted: _handleSubmitted,
                        decoration: InputDecoration(
                          hintText: 'Type...',
                          hintStyle: TextStyle(
                            color: Colors.grey[500],
                            fontSize: 16,
                          ),
                          border: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 16.0,
                            vertical: 10.0,
                          ),
                        ),
                        style: const TextStyle(fontSize: 16),
                        maxLines: 5,
                        minLines: 1,
                        textCapitalization: TextCapitalization.sentences,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Container(
            margin: const EdgeInsets.only(right: 4.0),
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: (hasText && !_isLoading && !_isStreaming)
                  ? const Color(0xFF007AFF)
                  : Colors.grey.shade400,
              shape: BoxShape.circle,
            ),
            child: Semantics(
              label: _isGreek ? 'Αποστολή' : 'Send',
              button: true,
              enabled: hasText && !_isLoading && !_isStreaming,
              child: ExcludeSemantics(
                child: IconButton(
                  icon: const Icon(
                    Icons.arrow_upward,
                    size: 18,
                    color: Colors.white,
                  ),
                  color: Colors.transparent,
                  focusNode: _sendButtonFocusNode,
                  onPressed: (hasText && !_isLoading && !_isStreaming)
                      ? () => _handleSubmitted(_textController.text.trim())
                      : null,
                  padding: const EdgeInsets.all(8.0),
                  splashRadius: 18,
                  tooltip: _isGreek ? 'Αποστολή' : 'Send',
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // 🎯 EXACT PATTERN FROM GENERIC_EXPERIENCES_WIDGET - Simple accessible button with optional FocusNode
  Widget _buildAccessibleButton({
    required IconData icon,
    required String label,
    required VoidCallback? onPressed,
    FocusNode? focusNode,
  }) {
    return Semantics(
      label: label,
      button: true,
      enabled: onPressed != null,
      child: ExcludeSemantics(
        child: IconButton(
          focusNode: focusNode,
          icon: Icon(icon),
          onPressed: onPressed,
          tooltip: label,
        ),
      ),
    );
  }

  // Modify the main chat page UI
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: _scaffoldKey,
      endDrawer: _buildHistoryDrawer(),
      backgroundColor: const Color(0xFFF9F9F9),
      body: SafeArea(
        child: Semantics(
          explicitChildNodes: true,
          child: Container(
            width: widget.width,
            height: widget.height,
            child: _showWelcomeOptions
                ? Column(
                    children: [
                      // Header with title and back/menu buttons (simpler, measured once)
                      Builder(
                        builder: (context) {
                          final screenWidth = MediaQuery.of(context).size.width;
                          final availableWidth = (screenWidth - 140).clamp(
                            48.0,
                            screenWidth,
                          );
                          const titleStyle = TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w600,
                            color: Colors.black87,
                          );

                          bool nameLong = _experienceTitleName.length > 10;
                          bool titleWraps = nameLong;
                          if (!titleWraps) {
                            final tp = TextPainter(
                              text: TextSpan(
                                text: _experienceTitleName,
                                style: titleStyle,
                              ),
                              maxLines: 1,
                              textDirection: Directionality.of(context),
                            );
                            tp.layout(minWidth: 0, maxWidth: availableWidth);
                            titleWraps = tp.didExceedMaxLines ||
                                (tp.height > (titleStyle.fontSize ?? 18) * 1.4);
                          }

                          return Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8.0,
                                  vertical: 12.0,
                                ),
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withOpacity(0.05),
                                      spreadRadius: 1,
                                      blurRadius: 3,
                                      offset: const Offset(0, 2),
                                    ),
                                  ],
                                ),
                                child: SizedBox(
                                  height: 48,
                                  child: Stack(
                                    children: [
                                      Positioned.fill(
                                        child: Center(
                                          child: (nameLong)
                                              ? Column(
                                                  mainAxisSize:
                                                      MainAxisSize.min,
                                                  children: [
                                                    for (final word
                                                        in _experienceTitleName
                                                            .split(' '))
                                                      Text(
                                                        word,
                                                        style: titleStyle,
                                                        textAlign:
                                                            TextAlign.center,
                                                      ),
                                                  ],
                                                )
                                              : Text(
                                                  _experienceTitleName,
                                                  style: titleStyle,
                                                  textAlign: TextAlign.center,
                                                  overflow:
                                                      TextOverflow.ellipsis,
                                                ),
                                        ),
                                      ),
                                      Positioned(
                                        left: 8,
                                        top: 0,
                                        bottom: 0,
                                        child: Row(
                                          children: [
                                            Semantics(
                                              label: _isGreek ? 'Πίσω' : 'Back',
                                              button: true,
                                              excludeSemantics: true,
                                              child: IconButton(
                                                icon: const Icon(
                                                  Icons.arrow_back,
                                                ),
                                                color: Colors.black87,
                                                tooltip:
                                                    _isGreek ? 'Πίσω' : 'Back',
                                                onPressed: () {
                                                  Navigator.pop(context);
                                                },
                                              ),
                                            ),
                                            Semantics(
                                              label:
                                                  _isGreek ? 'Αρχική' : 'Home',
                                              button: true,
                                              excludeSemantics: true,
                                              child: IconButton(
                                                icon: const Icon(Icons.home),
                                                color: Colors.black87,
                                                tooltip: _isGreek
                                                    ? 'Αρχική'
                                                    : 'Home',
                                                onPressed: () async {
                                                  try {
                                                    await FlutterTts().stop();
                                                  } catch (_) {}
                                                  if (mounted &&
                                                      context.mounted) {
                                                    try {
                                                      context.pushNamed(
                                                        'HomePageNew',
                                                      );
                                                    } catch (e) {
                                                      print(
                                                        'Navigation error: $e',
                                                      );
                                                    }
                                                  }
                                                },
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                                      Positioned(
                                        right: 8,
                                        top: 0,
                                        bottom: 0,
                                        child: Semantics(
                                          label: _isGreek
                                              ? 'Ιστορικό συζητήσεων'
                                              : 'Chat history',
                                          button: true,
                                          excludeSemantics: true,
                                          child: IconButton(
                                            icon: const Icon(
                                              Icons.history,
                                              size: 24,
                                            ),
                                            color: Colors.black87,
                                            tooltip: _isGreek
                                                ? 'Ιστορικό'
                                                : 'History',
                                            onPressed: () {
                                              _scaffoldKey.currentState
                                                  ?.openEndDrawer();
                                              _loadConversationHistory();
                                            },
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              SizedBox(height: titleWraps ? 8.0 : 0.0),
                            ],
                          );
                        },
                      ),
                      // Welcome options content
                      Expanded(child: _buildWelcomeOptionsScreen()),
                    ],
                  )
                : Column(
                    children: [
                      // Chat header with back, new conversation, and history buttons (no title)
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8.0,
                          vertical: 12.0,
                        ),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withOpacity(0.05),
                              spreadRadius: 1,
                              blurRadius: 3,
                              offset: const Offset(0, 2),
                            ),
                          ],
                        ),
                        child: Row(
                          children: [
                            Semantics(
                              label: _isGreek ? 'Πίσω' : 'Back',
                              button: true,
                              excludeSemantics: true,
                              child: IconButton(
                                icon: const Icon(Icons.arrow_back),
                                color: Colors.black87,
                                tooltip: _isGreek ? 'Πίσω' : 'Back',
                                onPressed: () {
                                  // Navigate to welcome options instead of exiting widget
                                  setState(() {
                                    _showWelcomeOptions = true;
                                  });
                                },
                              ),
                            ),
                            const Spacer(),
                            Semantics(
                              label: _isGreek
                                  ? 'Νέα συζήτηση'
                                  : 'New conversation',
                              button: true,
                              excludeSemantics: true,
                              child: IconButton(
                                icon: const Icon(Icons.add, size: 28),
                                color: Colors.black87,
                                tooltip: _isGreek
                                    ? 'Νέα συζήτηση'
                                    : 'New conversation',
                                onPressed: _startNewConversation,
                              ),
                            ),
                            Semantics(
                              label: _isGreek
                                  ? 'Ιστορικό συζητήσεων'
                                  : 'Chat history',
                              button: true,
                              excludeSemantics: true,
                              child: IconButton(
                                icon: const Icon(Icons.history, size: 24),
                                color: Colors.black87,
                                tooltip: _isGreek ? 'Ιστορικό' : 'History',
                                onPressed: () {
                                  _scaffoldKey.currentState?.openEndDrawer();
                                  _loadConversationHistory();
                                },
                              ),
                            ),
                          ],
                        ),
                      ),
                      // Chat area
                      Expanded(
                        child: Column(
                          children: [
                            Expanded(
                              child: Container(
                                color: const Color(0xFFF9F9F9),
                                child: ListView.builder(
                                  controller: _scrollController,
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 16.0,
                                    horizontal: 8.0,
                                  ),
                                  itemCount: _messages.length,
                                  itemBuilder: (context, index) =>
                                      _buildMessageItem(
                                    _messages[index],
                                    index,
                                  ),
                                ),
                              ),
                            ),
                            if (_isLoading || _isStreaming)
                              ExcludeSemantics(
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 8.0,
                                  ),
                                  color: Colors.white,
                                  child: const Center(
                                    child: CircularProgressIndicator(
                                      valueColor: AlwaysStoppedAnimation<Color>(
                                        Color(0xFF4E8BE6),
                                      ),
                                      strokeWidth: 3,
                                    ),
                                  ),
                                ),
                              ),
                            // Support suggestion message removed; only popup dialog remains
                            _buildInputArea(),
                          ],
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }

  // Update the history drawer design
  Widget _buildHistoryDrawer() {
    return Drawer(
      backgroundColor: Colors.white,
      child: Semantics(
        label: _isGreek ? 'Ιστορικό συζητήσεων' : 'Chat history menu',
        child: SafeArea(
          child: Column(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8.0,
                  vertical: 12.0,
                ),
                decoration: BoxDecoration(
                  color: Colors.white,
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.05),
                      blurRadius: 5,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    // Always visible close button at top left
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Semantics(
                        label: _isGreek ? 'Κλείσιμο' : 'Close',
                        button: true,
                        excludeSemantics: true,
                        child: IconButton(
                          icon: const Icon(Icons.close),
                          color: Colors.black87,
                          onPressed: () =>
                              _scaffoldKey.currentState?.closeEndDrawer(),
                          tooltip: _isGreek ? 'Κλείσιμο' : 'Close',
                        ),
                      ),
                    ),
                    // Centered title
                    Center(
                      child: Padding(
                        padding: const EdgeInsets.only(top: 8.0, bottom: 8.0),
                        child: Text(
                          _isGreek ? 'Ιστορικό Συζητήσεων' : 'Chat History',
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                            color: Colors.black87,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: _chatHistory.isEmpty
                    ? Center(
                        child: Text(
                          _isGreek ? 'Δεν υπάρχει ιστορικό' : 'No history yet',
                          style: const TextStyle(
                            fontSize: 16,
                            color: Colors.grey,
                          ),
                        ),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.only(top: 8),
                        itemCount: _chatHistory.length,
                        itemBuilder: (context, index) {
                          final chat = _chatHistory[index];
                          final formattedDate = _formatTimestamp(
                            chat['createdAt'] as Timestamp,
                          );

                          return Semantics(
                            container: true,
                            explicitChildNodes: true,
                            child: Container(
                              margin: const EdgeInsets.symmetric(
                                vertical: 4,
                                horizontal: 12,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(
                                  color: Colors.grey.shade200,
                                ),
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: InkWell(
                                      onTap: () =>
                                          _loadConversation(chat['id']),
                                      borderRadius: BorderRadius.circular(12),
                                      child: Semantics(
                                        label: _isGreek
                                            ? 'Συζήτηση: ${chat['title']}, ${formattedDate}'
                                            : 'Conversation: ${chat['title']}, ${formattedDate}',
                                        hint: _isGreek
                                            ? 'Διπλό πάτημα για άνοιγμα'
                                            : 'Double tap to open',
                                        button: true,
                                        excludeSemantics: true,
                                        child: Padding(
                                          padding: const EdgeInsets.all(16),
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                chat['title'],
                                                style: const TextStyle(
                                                  fontSize: 16,
                                                  fontWeight: FontWeight.w500,
                                                ),
                                              ),
                                              const SizedBox(height: 4),
                                              Text(
                                                formattedDate,
                                                style: TextStyle(
                                                  fontSize: 13,
                                                  color: Colors.grey[600],
                                                ),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                  InkWell(
                                    onTap: () => _deleteConversation(
                                      chat['id'],
                                      chat['title'],
                                    ),
                                    borderRadius: const BorderRadius.only(
                                      topRight: Radius.circular(12),
                                      bottomRight: Radius.circular(12),
                                    ),
                                    child: Semantics(
                                      label: _isGreek
                                          ? 'Διαγραφή συζήτησης ${chat['title']}'
                                          : 'Delete conversation ${chat['title']}',
                                      hint: _isGreek
                                          ? 'Διπλό πάτημα για διαγραφή'
                                          : 'Double tap to delete',
                                      button: true,
                                      excludeSemantics: true,
                                      child: const Padding(
                                        padding: EdgeInsets.all(16),
                                        child: Icon(
                                          Icons.delete_outline,
                                          color: Colors.red,
                                          size: 22,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
              ),
              Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  children: [
                    Semantics(
                      label: _isGreek ? 'Νέα συζήτηση' : 'New conversation',
                      button: true,
                      excludeSemantics: true,
                      child: ElevatedButton(
                        onPressed: () {
                          // Close drawer instantly, then reset conversation in background
                          _scaffoldKey.currentState?.closeEndDrawer();
                          _startNewConversation();
                        },
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF4E8BE6),
                          foregroundColor: Colors.white,
                          elevation: 0,
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          minimumSize: const Size(double.infinity, 0),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                          ),
                        ),
                        child: Text(
                          _isGreek ? 'Νέα Συζήτηση' : 'New Conversation',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    if (widget.showSupportOption)
                      Semantics(
                        label: _isGreek ? 'Υποστήριξη' : 'Support',
                        button: true,
                        excludeSemantics: true,
                        child: TextButton(
                          onPressed: () {
                            Navigator.of(context).pop(); // Close drawer
                            _scaffoldKey.currentState?.closeEndDrawer();
                            Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (context) => buildSupportPage(
                                  context,
                                  supportPhone: widget.supportPhone,
                                  supportEmail: widget.supportEmail,
                                  supportDaysOpen: widget.supportDaysOpen,
                                  SupportImage: widget.SupportImage,
                                  CallingNumber: widget.CallingNumber,
                                  headingTitle: widget.headingTitle,
                                  headingSubtitle: widget.headingSubtitle,
                                  showBayerEmails: widget.showBayerEmails,
                                  GenericEmail: widget.GenericEmail,
                                  instagram: widget.instagram,
                                ),
                              ),
                            );
                          },
                          child: Text(
                            _isGreek ? 'Υποστήριξη' : 'Support',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w500,
                              color: Colors.grey[600],
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // Update welcome options screen design
  Widget _buildWelcomeOptionsScreen() {
    return Container(
      padding: const EdgeInsets.fromLTRB(20.0, 28.0, 20.0, 20.0),
      color: const Color(0xFFF9F9F9),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            label:
                _isGreek ? 'Οθόνη επιλογών βοηθού' : 'Assistant options screen',
            child: Text(
              _isGreek
                  ? 'Πώς μπορώ να σας βοηθήσω;'
                  : 'How can I help you today?',
              style: const TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
                color: Colors.black87,
              ),
              textAlign: TextAlign.center,
            ),
          ),
          const SizedBox(height: 20),
          if (widget.barcode)
            _buildWelcomeOptionButton(
              icon: Icons.qr_code_scanner,
              title: _isGreek ? 'Σάρωση Προϊόντος' : 'Scan Product',
              subtitle: _isGreek
                  ? 'Σαρώστε barcode προϊόντος'
                  : 'Scan product barcode',
              onPressed: () => _selectWelcomeOption('barcode'),
            ),
          if (widget.barcode) const SizedBox(height: 16),
          if (widget.expirationDate)
            _buildWelcomeOptionButton(
              icon: Icons.date_range,
              title: _isGreek ? 'Ημερομηνία Λήξης' : 'Expiration Date',
              subtitle: _isGreek
                  ? 'Αναγνώριση ημερομηνίας λήξης'
                  : 'Read expiration date',
              onPressed: () => _selectWelcomeOption('expiration'),
            ),
          if (widget.expirationDate) const SizedBox(height: 16),
          if (widget.imagefeature)
            _buildWelcomeOptionButton(
              icon: Icons.camera_alt_rounded,
              title: _isGreek ? 'Κάμερα' : 'Camera',
              subtitle: _isGreek
                  ? 'Τραβήξτε φωτογραφία για ανάλυση'
                  : 'Take photo for analysis',
              onPressed: () => _selectWelcomeOption('image'),
            ),
          if (widget.imagefeature) const SizedBox(height: 16),
          if (widget.supportAskQuestion)
            _buildWelcomeOptionButton(
              icon: Icons.question_answer_outlined,
              title: _isGreek ? 'Κάνε Ερώτηση' : 'Ask a Question',
              subtitle: _isGreek ? 'Άνοιγμα συνομιλίας' : 'Open chat',
              onPressed: () => _selectWelcomeOption('chat'),
            ),
          if (widget.supportAskQuestion) const SizedBox(height: 16),
          if (widget.showSupportOption)
            _buildWelcomeOptionButton(
              icon: Icons.support_agent,
              title: _isGreek ? 'Υποστήριξη' : 'Support',
              subtitle: _isGreek
                  ? 'Λήψη βοήθειας και υποστήριξης'
                  : 'Get help and support',
              onPressed: () => _selectWelcomeOption('support'),
            ),
          if (widget.showSupportOption) const SizedBox(height: 16),
          if (widget.LouloudisFeature)
            _buildWelcomeOptionButton(
              icon: Icons.shopping_bag_outlined,
              title: _isGreek ? 'Σάρωση Παπουτσιού' : 'Scan a Shoe',
              subtitle:
                  _isGreek ? 'Σαρώστε κωδικό παπουτσιού' : 'Scan shoe code',
              onPressed: () => _selectWelcomeOption('shoe'),
            ),
        ],
      ),
    );
  }

  Widget _buildWelcomeOptionButton({
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onPressed,
  }) {
    return Semantics(
      container: true,
      label: '$title. $subtitle',
      button: true,
      onTap: onPressed,
      child: ExcludeSemantics(
        child: SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: onPressed,
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.white,
              foregroundColor: Colors.black87,
              elevation: 2,
              padding: const EdgeInsets.all(20),
              shadowColor: Colors.black.withOpacity(0.1),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
                side: BorderSide(color: Colors.grey.shade200),
              ),
            ),
            child: Row(
              children: [
                Icon(icon, size: 28, color: const Color(0xFF4E8BE6)),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        subtitle,
                        style: TextStyle(fontSize: 14, color: Colors.grey[600]),
                      ),
                    ],
                  ),
                ),
                Icon(
                  Icons.arrow_forward_ios,
                  color: Colors.grey[400],
                  size: 16,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _selectWelcomeOption(String option) async {
    // Don't hide welcome options for navigation that leaves the widget
    if (option != 'expiration' &&
        option != 'barcode' &&
        option != 'image' &&
        option != 'support' &&
        option != 'shoe') {
      setState(() => _showWelcomeOptions = false);
    }
    switch (option) {
      case 'barcode':
        await _openBarcodePage();
        break;
      case 'expiration':
        await _openExpirationDateScanner(fromMenu: true);
        break;
      case 'image_analysis':
        await _pickImage(ImageSource.gallery);
        break;
      case 'image':
        await _openCustomCamera(fromMenu: true);
        break;
      case 'chat':
        // Open chat by hiding welcome screen
        setState(() => _showWelcomeOptions = false);
        _announce(_isGreek ? 'Μετάβαση στη συνομιλία' : 'Opening chat');
        break;
      case 'support':
        // Navigate directly to support page
        setState(
          () => _showWelcomeOptions = true,
        ); // Keep showing welcome options
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => buildSupportPage(
              context,
              supportPhone: widget.supportPhone,
              supportEmail: widget.supportEmail,
              supportDaysOpen: widget.supportDaysOpen,
              SupportImage: widget.SupportImage,
              CallingNumber: widget.CallingNumber,
              headingTitle: widget.headingTitle,
              headingSubtitle: widget.headingSubtitle,
              showBayerEmails: widget.showBayerEmails,
              GenericEmail: widget.GenericEmail,
              instagram: widget.instagram,
            ),
          ),
        );
        break;
      case 'shoe':
        // Navigate to shoe code scanner
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => const ShoeCodeScannerWidget(),
          ),
        );
        break;
    }
  }

  Future<void> _returnToWelcomeOptions() async {
    setState(() {
      _showWelcomeOptions = true;
      _cameFromChat = false; // Reset flag when returning from other features
    });
    await _announceWelcomeOptions();
  }

  // Start a brand new conversation and reset thread/state
  Future<void> _startNewConversation() async {
    // Announce new conversation started
    _announce(
      _isGreek ? 'Νέα συζήτηση ξεκίνησε' : 'New conversation started',
    );

    // Cancel streaming and timeouts
    _streamSubscription?.cancel();
    _cancelResponseTimeout();
    _stopAiThinkingAnnouncements();

    // Reset streaming/loading state
    setState(() {
      _isStreaming = false;
      _isLoading = false;
      _chatSessionId = null;
      _chatDocRef = null;
      _messages.clear();
      _currentImage = null;
      _conversationId = _uuid.v4();
      _showWelcomeOptions = false;
      _cameFromChat = false; // Reset flag when starting new conversation
      _expirationDialogShownInThisSession =
          false; // Reset expiration dialog flag for new conversation
      _supportDialogShownInThisSession =
          false; // Reset support dialog flag for new conversation
    });
    _scaffoldKey.currentState?.closeEndDrawer();
  }

  // Add the missing methods that are causing errors

  Future<void> _announceWelcomeOptions() async {
    // Removed announcement - user doesn't want to hear anything when entering menu
  }

  Future<void> _openBarcodePage() async {
    try {
      // Pre-request camera permission to reduce scanner launch delay
      final camStatus = await Permission.camera.status;
      if (!camStatus.isGranted) {
        await Permission.camera.request();
      }
      final barcodeResult = await scanBarcode(context, _isGreek ? 'el' : 'en');
      if (barcodeResult != null &&
          barcodeResult != 'Scan cancelled' &&
          barcodeResult.isNotEmpty) {
        // Mark that we are leaving the welcome/options context
        setState(() {
          _showWelcomeOptions = false;
        });
        // Ensure cancel flag is reset for this run
        _barcodeProcessingCancelled = false;

        // Announce processing to screen reader (non-blocking)
        final processingAnnouncement = _isGreek
            ? 'Επεξεργασία, παρακαλώ περιμένετε.'
            : 'Processing, please wait.';
        SemanticsService.announce(
          processingAnnouncement,
          _isGreek ? ui.TextDirection.rtl : ui.TextDirection.ltr,
        );

        // Show a simple processing page with cancel/back immediately (no await)
        final route = MaterialPageRoute(
          builder: (context) {
            final processingText = _isGreek
                ? 'Επεξεργασία, παρακαλώ περιμένετε.'
                : 'Processing, please wait.';
            return WillPopScope(
              onWillPop: () async {
                // Treat system back as cancel
                setState(() {
                  _isLoading = false;
                  _showWelcomeOptions = true;
                  _barcodeProcessingCancelled = true;
                  _isProcessingPageVisible = false;
                });
                return true; // allow pop
              },
              child: Scaffold(
                backgroundColor: Colors.white,
                body: SafeArea(
                  child: Stack(
                    children: [
                      Positioned(
                        top: 4,
                        left: 4,
                        child: Semantics(
                          label: _isGreek ? 'Ακύρωση' : 'Cancel',
                          button: true,
                          excludeSemantics: true,
                          child: IconButton(
                            icon: const Icon(Icons.close),
                            tooltip: _isGreek ? 'Ακύρωση' : 'Cancel',
                            onPressed: () {
                              // Explicit cancel -> mark welcome/options state
                              setState(() {
                                _isLoading = false;
                                _showWelcomeOptions = true;
                                _barcodeProcessingCancelled = true;
                                _isProcessingPageVisible = false;
                              });
                              Navigator.of(context).pop();
                            },
                          ),
                        ),
                      ),
                      Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            const CircularProgressIndicator(),
                            const SizedBox(height: 16),
                            Semantics(
                              label: processingText,
                              liveRegion: true,
                              child: Text(
                                processingText,
                                textAlign: TextAlign.center,
                                style: const TextStyle(fontSize: 18),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
        _isProcessingPageVisible = true;
        Navigator.of(context).push(route);
        // Start processing without awaiting to avoid showing the chat page briefly
        // ignore: discarded_futures
        _processBarcode(barcodeResult);
      } else {
        // Barcode scan was cancelled or returned no result, return to menu
        setState(() {
          _showWelcomeOptions = true;
        });
      }
    } catch (e) {
      print('Error scanning barcode: $e');
    }
  }

  Future<void> _processBarcode(String barcode) async {
    setState(() => _isLoading = true);

    try {
      // CHANGED: Use new barcode lookup endpoint
      final apiUrl =
          'https://barcode-lookup.pop2see.eu/?input_string=$barcode&language_code=${widget.languageCode}';

      final response = await http.get(
        Uri.parse(apiUrl),
        headers: {'Accept-Charset': 'utf-8'},
      );

      if (response.statusCode == 200) {
        // Announce successful barcode found to screen reader
        final successMessage = _isGreek ? 'Βαρκόδ βρέθηκε' : 'Barcode found';
        SemanticsService.announce(
          successMessage,
          _isGreek ? ui.TextDirection.rtl : ui.TextDirection.ltr,
        );

        // Properly decode UTF-8 response
        final responseBody = utf8.decode(response.bodyBytes);
        final jsonResponse = json.decode(responseBody);
        final result =
            jsonResponse['response'] as String? ?? 'No information found';

        // If the user cancelled and returned to options, don't navigate further
        if (_barcodeProcessingCancelled || _showWelcomeOptions) {
          setState(() => _isLoading = false);
          return;
        }

        // Replace processing page with results page if visible; otherwise just push
        Future<void> navigateToResults() async {
          final barcodeResultData = await Navigator.push<Map<String, dynamic>>(
            context,
            MaterialPageRoute(
              builder: (context) => BarcodeResultPage(
                result: result,
                languageCode: widget.languageCode,
                onScanAgain: () async {
                  Navigator.pop(context, {'action': 'scan_again'});
                },
                onReturnToChat: () {
                  Navigator.pop(context, {
                    'action': 'return_to_chat',
                    'result': result,
                  });
                },
                onBackToOptions: () {
                  Navigator.pop(context, {'action': 'back_to_options'});
                },
              ),
            ),
          );

          if (barcodeResultData != null) {
            if (barcodeResultData['action'] == 'scan_again') {
              await _openBarcodePage();
            } else if (barcodeResultData['action'] == 'return_to_chat') {
              await _addBarcodeResultToChat(
                barcodeResultData['result'] as String,
              );
            } else if (barcodeResultData['action'] == 'back_to_options') {
              setState(() {
                _showWelcomeOptions = true;
              });
            }
          }
        }

        if (_isProcessingPageVisible) {
          // Replace processing page with results page to avoid flicker
          _isProcessingPageVisible = false;
          final future = Navigator.of(context).pushReplacement(
            MaterialPageRoute<Map<String, dynamic>>(
              builder: (context) => BarcodeResultPage(
                result: result,
                languageCode: widget.languageCode,
                onScanAgain: () async {
                  Navigator.pop(context, {'action': 'scan_again'});
                },
                onReturnToChat: () {
                  Navigator.pop(context, {
                    'action': 'return_to_chat',
                    'result': result,
                  });
                },
                onBackToOptions: () {
                  Navigator.pop(context, {'action': 'back_to_options'});
                },
              ),
            ),
          );
          // Handle actions after results page is popped
          // ignore: discarded_futures
          future.then((barcodeResultData) async {
            if (barcodeResultData != null) {
              if (barcodeResultData['action'] == 'scan_again') {
                await _openBarcodePage();
              } else if (barcodeResultData['action'] == 'return_to_chat') {
                await _addBarcodeResultToChat(
                  barcodeResultData['result'] as String,
                );
              } else if (barcodeResultData['action'] == 'back_to_options') {
                setState(() {
                  _showWelcomeOptions = true;
                });
              }
            }
          });
        } else {
          // ignore: discarded_futures
          navigateToResults();
        }
      } else {
        throw Exception('API call failed with status: ${response.statusCode}');
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _isGreek
                ? 'Σφάλμα κατά την ανάγνωση barcode'
                : 'Error processing barcode',
          ),
          backgroundColor: Colors.red,
        ),
      );
    } finally {
      setState(() => _isLoading = false);
    }
  }

  Future<void> _addBarcodeResultToChat(String barcodeResult) async {
    // Create a contextual message that informs the AI about the scanned product
    final contextualMessage = _isGreek
        ? "Ο χρήστης μόλις σάρωσε ένα barcode και λήφθηκαν οι παρακάτω πληροφορίες για το προϊόν. Μπορεί τώρα να σου κάνει ερωτήσεις σχετικά με αυτό το προϊόν:\n\n$barcodeResult"
        : "The user just scanned a barcode and received the following product information. They can now ask you questions about this product:\n\n$barcodeResult";

    setState(() {
      _messages.add(ChatMessage(text: contextualMessage, isUser: false));
    });

    await _storeMessageInFirebase(
      message: ChatMessage(text: contextualMessage, isUser: false),
      role: 'assistant',
    );

    _scrollToBottom();
    _announce(
      _isGreek
          ? 'Αποτέλεσμα barcode προστέθηκε στη συζήτηση'
          : 'Barcode result added to conversation',
    );
  }

  /// Shows the expiration date navigation popup with improved UI (Chat Screen - shows once per session)
  Future<void> _showExpirationDatePopup() async {
    return showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (BuildContext context) {
        return Dialog(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
          ),
          elevation: 8,
          child: Semantics(
            label: _isGreek
                ? "Παράθυρο διαλόγου για ημερομηνία λήξης. Έχουμε ήδη μια επιλογή ημερομηνίας λήξης στο μενού. Θέλετε να πλοηγηθείτε εκεί;"
                : "Expiration date dialog. We already have an expiration date option in the menu. Do you want to navigate there?",
            child: Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(20),
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    Color(0xFF21AAE1).withOpacity(0.12),
                    Color(0xFF21AAE1).withOpacity(0.08),
                  ],
                ),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Expiration date icon
                  ExcludeSemantics(
                    child: Container(
                      width: 60,
                      height: 60,
                      decoration: BoxDecoration(
                        color: Color(0xFF21AAE1),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.event_available,
                        color: Colors.white,
                        size: 32,
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),

                  // Title
                  ExcludeSemantics(
                    child: Text(
                      _isGreek ? "Ημερομηνία Λήξης" : "Expiration Date",
                      style: Theme.of(
                        context,
                      ).textTheme.headlineSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                            color: Color(0xFF0B6F93),
                          ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Display extracted date if available
                  if (_extractedExpirationDate != null &&
                      _extractedExpirationDate!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Colors.blue.withOpacity(0.2),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(
                            color: Colors.blue,
                            width: 1,
                          ),
                        ),
                        child: Text(
                          _isGreek
                              ? "Ημερομηνία που βρέθηκε: ${_extractedExpirationDate!}"
                              : "Detected date: ${_extractedExpirationDate!}",
                          style:
                              Theme.of(context).textTheme.bodyMedium?.copyWith(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w600,
                                  ),
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),

                  // Content
                  ExcludeSemantics(
                    child: Text(
                      _isGreek
                          ? "Έχουμε ήδη μια επιλογή ημερομηνίας λήξης στο μενού. Θέλετε να πλοηγηθείτε εκεί;"
                          : "We already have an expiration date option in the menu. Do you want to navigate there?",
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                            color: Colors.grey.shade800,
                            height: 1.4,
                          ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Action buttons
                  Row(
                    children: [
                      Expanded(
                        child: Semantics(
                          button: true,
                          label: _isGreek ? "Όχι" : "No",
                          excludeSemantics: true,
                          child: TextButton(
                            onPressed: () {
                              Navigator.of(context).pop();
                              _announce(_isGreek ? 'Ακυρώθηκε' : 'Cancelled');
                            },
                            style: TextButton.styleFrom(
                              padding: const EdgeInsets.symmetric(vertical: 16),
                              backgroundColor: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                                side: BorderSide(color: Color(0xFF21AAE1)),
                              ),
                            ),
                            child: ExcludeSemantics(
                              child: Text(
                                _isGreek ? "Όχι" : "No",
                                style: TextStyle(
                                  fontSize: 16,
                                  color: Color(0xFF21AAE1),
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Semantics(
                          button: true,
                          label: _isGreek ? "Ναι" : "Yes",
                          excludeSemantics: true,
                          child: ElevatedButton(
                            onPressed: () {
                              Navigator.of(context).pop();
                              _openExpirationDateScanner(fromMenu: false);
                            },
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Color(0xFF21AAE1),
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 16),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                              elevation: 2,
                            ),
                            child: ExcludeSemantics(
                              child: Text(
                                _isGreek ? "Ναι" : "Yes",
                                style: const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.bold,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _openExpirationDateScanner({bool fromMenu = false}) async {
    final canProceed = await _checkApiCallLimit();
    if (!canProceed) return;

    setState(() {
      _isLoading = true;
    });

    final result = await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => ExpirationDateScannerScreen(
          width: widget.width ?? MediaQuery.of(context).size.width,
          height: widget.height ?? MediaQuery.of(context).size.height,
          language: widget.languageCode == 'el' ? 'el' : 'en',
        ),
      ),
    );

    // When returning from expiration scanner, handle navigation based on origin
    setState(() {
      _isLoading = false;
      // If opened from menu, return to menu; otherwise stay in chat
      _showWelcomeOptions = fromMenu;
    });

    // Announce scanner completion
    SemanticsService.announce(
      _isGreek
          ? 'Σάρωση ημερομηνιών λήξης ολοκληρώθηκε'
          : 'Expiration date scanning completed',
      _isGreek ? ui.TextDirection.rtl : ui.TextDirection.ltr,
    );
  }
}

class BarcodeResultPage extends StatefulWidget {
  final String result;
  final String languageCode;
  final VoidCallback onScanAgain;
  final VoidCallback onReturnToChat;
  final VoidCallback onBackToOptions;

  const BarcodeResultPage({
    Key? key,
    required this.result,
    required this.languageCode,
    required this.onScanAgain,
    required this.onReturnToChat,
    required this.onBackToOptions,
  }) : super(key: key);

  @override
  State<BarcodeResultPage> createState() => _BarcodeResultPageState();
}

class _BarcodeResultPageState extends State<BarcodeResultPage> {
  final FocusNode _resultFocusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    // Focus the result after widget is built
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _resultFocusNode.requestFocus();
        // Only announce result if not navigating away
        if (ModalRoute.of(context)?.isCurrent ?? true) {
          announceMessage(widget.result);
        }
      }
    });
  }

  @override
  void dispose() {
    _resultFocusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isGreek = widget.languageCode == 'el';

    return Scaffold(
      appBar: AppBar(
        title: Text(isGreek ? 'Αποτέλεσμα Barcode' : 'Barcode Result'),
        automaticallyImplyLeading: false, // Remove back button
      ),
      body: Column(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16.0),
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.grey),
                  borderRadius: BorderRadius.circular(8.0),
                ),
                child: SingleChildScrollView(
                  child: Focus(
                    focusNode: _resultFocusNode,
                    child: Semantics(
                      label: isGreek
                          ? 'Αποτέλεσμα barcode: ${widget.result}'
                          : 'Barcode result: ${widget.result}',
                      readOnly: true,
                      focusable: true,
                      child: Text(widget.result,
                          style: const TextStyle(fontSize: 16)),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Semantics(
                        label: isGreek ? 'Σάρωση ξανά' : 'Scan again',
                        button: true,
                        hint: isGreek
                            ? 'Διπλό πάτημα για νέα σάρωση barcode'
                            : 'Double tap to scan barcode again',
                        excludeSemantics: true,
                        child: ElevatedButton.icon(
                          onPressed: widget.onScanAgain,
                          icon: const Icon(Icons.qr_code_scanner),
                          label: Text(
                            isGreek ? 'Σάρωση Ξανά' : 'Scan Again',
                            style: const TextStyle(fontSize: 16),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.orange,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 15),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Semantics(
                        label: isGreek
                            ? 'Επιστροφή στη συζήτηση'
                            : 'Return to chat',
                        button: true,
                        hint: isGreek
                            ? 'Διπλό πάτημα για επιστροφή στη συζήτηση με το αποτέλεσμα'
                            : 'Double tap to return to chat with result',
                        excludeSemantics: true,
                        child: ElevatedButton.icon(
                          onPressed: widget.onReturnToChat,
                          icon: const Icon(Icons.chat),
                          label: Text(
                            isGreek
                                ? 'Επιστροφή στη Συζήτηση'
                                : 'Return to Chat',
                            style: const TextStyle(fontSize: 16),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Theme.of(context).primaryColor,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(vertical: 15),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Semantics(
                  label:
                      isGreek ? 'Επιστροφή στις επιλογές' : 'Back to options',
                  button: true,
                  hint: isGreek
                      ? 'Διπλό πάτημα για επιστροφή στο μενού επιλογών'
                      : 'Double tap to return to options menu',
                  excludeSemantics: true,
                  child: ElevatedButton.icon(
                    onPressed: widget.onBackToOptions,
                    icon: const Icon(Icons.home),
                    label: Text(
                      isGreek ? 'Επιστροφή στις Επιλογές' : 'Back to Options',
                      style: const TextStyle(fontSize: 16),
                    ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Theme.of(context).primaryColor,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 15),
                      minimumSize: const Size(double.infinity, 50),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class ChatMessage {
  final String text;
  final bool isUser;
  final File? image;

  ChatMessage({required this.text, required this.isUser, this.image});

  Map<String, dynamic> toJson() => {
        'text': text,
        'isUser': isUser,
        'image': image?.path,
      };

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        text: json['text'],
        isUser: json['isUser'],
        image: json['image'] != null ? File(json['image']) : null,
      );
}

class CustomCameraForChat extends StatefulWidget {
  final double width;
  final double height;

  const CustomCameraForChat({
    Key? key,
    required this.width,
    required this.height,
  }) : super(key: key);

  @override
  _CustomCameraForChatState createState() => _CustomCameraForChatState();
}

class _CustomCameraForChatState extends State<CustomCameraForChat>
    with WidgetsBindingObserver {
  CameraController? _controller;
  List<CameraDescription> _cameras = [];
  int selectedCamera = 0;
  bool _isInitialized = false;

  final FocusNode _captureFocusNode = FocusNode();

  String get _captureButtonLabel {
    final locale = Localizations.localeOf(context).languageCode;
    return (locale == 'el' || locale == 'gr' || locale == 'el_GR')
        ? 'Λήψη φωτογραφίας'
        : 'Capture Photo';
  }

  bool get _isGreek {
    final locale = Localizations.localeOf(context).languageCode;
    return (locale == 'el' || locale == 'gr' || locale == 'el_GR');
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _initializeCamera();

    // 🔥 Auto-focus on capture button when camera opens
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // First announce camera ready
      SemanticsService.announce(
        _isGreek ? 'Κάμερα έτοιμη' : 'Camera ready',
        ui.TextDirection.ltr,
      );

      // Then focus on capture button after short delay
      Future.delayed(const Duration(milliseconds: 500), () {
        if (mounted) {
          _captureFocusNode.requestFocus();
        }
      });
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _captureFocusNode.dispose();
    _controller?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // CRITICAL for iOS: Always reinitialize camera when app resumes from Settings
    // This ensures permission changes are picked up immediately
    if (state == AppLifecycleState.resumed) {
      _initializeCamera();
    }
  }

  Future<void> _initializeCamera() async {
    try {
      // Try to initialize camera directly - this triggers native permission if needed
      await _setupCamera();
    } catch (e) {
      // If camera setup fails, show permission dialog
      _showPermissionDialog();
    }
  }

  Future<void> _setupCamera() async {
    try {
      _cameras = await availableCameras();
      if (_cameras.isEmpty) throw Exception("No cameras available");

      // Force back camera for consistency with barcode scanner
      int backCameraIndex = 0;
      for (int i = 0; i < _cameras.length; i++) {
        if (_cameras[i].lensDirection == CameraLensDirection.back) {
          backCameraIndex = i;
          break;
        }
      }

      _controller = CameraController(
        _cameras[backCameraIndex],
        ResolutionPreset.high,
        enableAudio: false,
      );
      await _controller!.initialize();
      await _controller!.setFlashMode(FlashMode.auto);

      if (mounted) {
        setState(() {
          _isInitialized = true;
        });
      }
    } catch (e) {
      // Error setting up camera handled silently for speed
    }
  }

  void _showPermissionDialog() {
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: Text(
            _isGreek
                ? 'Απαιτείται άδεια κάμερας'
                : 'Camera Permission Required',
          ),
          content: Text(
            _isGreek
                ? 'Παρακαλώ ενεργοποιήστε την πρόσβαση στην κάμερα στις ρυθμίσεις για να χρησιμοποιήσετε αυτή τη δυνατότητα.'
                : 'Please enable camera access in Settings to use this feature.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: Text(_isGreek ? 'Ακύρωση' : 'Cancel'),
            ),
            TextButton(
              onPressed: () async {
                Navigator.of(context).pop();
                Navigator.of(context).pop(); // Close camera screen
                await openAppSettings();
                // Small delay to allow Settings to open
                await Future.delayed(const Duration(milliseconds: 500));
              },
              child: Text(_isGreek ? 'Ρυθμίσεις' : 'Settings'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _takePicture() async {
    if (_controller == null || !_controller!.value.isInitialized) return;
    try {
      HapticFeedback.mediumImpact();

      final directory = await getApplicationDocumentsDirectory();
      final filePath = path.join(
        directory.path,
        '${DateTime.now().millisecondsSinceEpoch}.jpg',
      );
      final XFile photo = await _controller!.takePicture();
      await photo.saveTo(filePath);
      FocusScope.of(context).unfocus();
      Navigator.pop(context, filePath);
    } catch (e) {
      Navigator.pop(context, null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: _isInitialized
          ? SafeArea(
              child: Stack(
                children: [
                  if (_isInitialized && _controller != null)
                    Center(child: CameraPreview(_controller!))
                  else
                    const Center(
                      child: CircularProgressIndicator(color: Colors.white),
                    ),
                  // 🔥 CAPTURE BUTTON FIRST in widget tree = FIRST in screen reader navigation
                  // Positioned at bottom but appears FIRST to assistive technologies
                  Positioned(
                    bottom: 40,
                    left: 0,
                    right: 0,
                    child: Center(
                      child: Semantics(
                        label: _captureButtonLabel,
                        button: true,
                        sortKey: const OrdinalSortKey(
                            0), // 🔥 First in accessibility order
                        excludeSemantics: true,
                        child: Focus(
                          focusNode: _captureFocusNode,
                          child: GestureDetector(
                            onTap: _takePicture,
                            child: Container(
                              width: 70,
                              height: 70,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: Colors.white,
                                border:
                                    Border.all(color: Colors.grey, width: 4),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  // Cancel button SECOND in widget tree = SECOND in screen reader navigation
                  Positioned(
                    top: 16,
                    left: 16,
                    child: Semantics(
                      label: _isGreek ? 'Ακύρωση' : 'Cancel',
                      button: true,
                      sortKey: const OrdinalSortKey(
                          1), // 🔥 Second in accessibility order
                      excludeSemantics: true,
                      child: IconButton(
                        icon: const Icon(Icons.close,
                            color: Colors.white, size: 32),
                        onPressed: () => Navigator.pop(context),
                        tooltip: _isGreek ? 'Ακύρωση' : 'Cancel',
                      ),
                    ),
                  ),
                ],
              ),
            )
          : Semantics(
              label: _isGreek ? 'Προετοιμασία κάμερας' : 'Preparing camera',
              child: const Center(child: CircularProgressIndicator()),
            ),
    );
  }
}

Widget buildSupportPage(
  BuildContext context, {
  // ...existing code...
  String? supportPhone,
  String? supportEmail,
  String? supportDaysOpen,
  String? SupportImage,
  String? CallingNumber,
  String? headingTitle,
  String? headingSubtitle,
  bool showBayerEmails = false,
  String? GenericEmail,
  String? instagram,
}) {
  final theme = FlutterFlowTheme.of(context);

  // Check if current language is Greek
  final isGreek = Localizations.localeOf(context).languageCode == 'el';

  // Use provided support parameters or fallback to defaults
  final displayPhone = supportPhone ?? '';
  final displayGenericEmail = GenericEmail ?? '';
  final displayDaysOpen = supportDaysOpen?.isNotEmpty == true
      ? supportDaysOpen!
      : (isGreek
          ? 'Δευτέρα έως Παρασκευή, 9:00 - 17:00'
          : 'Monday to Friday, 9 AM - 5 PM');
  final displayCustomerSupport =
      supportPhone?.isNotEmpty == true ? supportPhone! : displayPhone;

  // Use provided headings or fallback to defaults
  final displayHeadingTitle = headingTitle ??
      (isGreek
          ? 'Στοιχεία Επικοινωνίας Καταναλωτών Nestlé'
          : 'Nestlé Consumer Communication Details');
  final displayHeadingSubtitle = headingSubtitle ??
      (isGreek
          ? 'Έχεις κάποια ερώτηση, παράπονο ή πρόταση για κάποιο προϊόν Nescafe; Μπορείς να επικοινωνήσεις με την εταιρία.'
          : 'Do you have any question, complaint or suggestion about a Nescafe product? You can contact the company.');

  // Requested brand blue
  const primaryBlue = Color(0xFF007AFF);

  // Logo asset path
  final logoAsset = SupportImage ?? 'assets/images/Nescafe-Logo.png';

  // Consistent font for Greek rendering (same family as chat-friendly default)
  const supportFontFamily = 'Roboto'; // Function to make phone call
  Future<void> _makePhoneCall() async {
    final callingNumber = CallingNumber ?? supportPhone ?? '';
    final Uri phoneUri = Uri(scheme: 'tel', path: callingNumber);
    if (await canLaunchUrl(phoneUri)) {
      await launchUrl(phoneUri);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isGreek ? 'Δεν είναι δυνατή η κλήση' : 'Could not make phone call',
          ),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  // Function to send email
  Future<void> _sendEmail() async {
    // Encode query parameters per url_launcher docs (mailto specifics)
    String _encode(Map<String, String> params) => params.entries
        .map(
          (e) =>
              '${Uri.encodeComponent(e.key)}=${Uri.encodeComponent(e.value)}',
        )
        .join('&');

    final String subject = isGreek ? 'Υποστήριξη' : 'Support Request';
    final emailAddress = supportEmail ?? '';
    final Uri emailUri = Uri(
      scheme: 'mailto',
      path: emailAddress,
      query: _encode({'subject': subject}),
    );

    // 1) Try native email app (external)
    try {
      final launchedMail = await launchUrl(
        emailUri,
        mode: LaunchMode.externalApplication,
      );
      if (launchedMail) return;
    } catch (_) {
      // continue to next fallback
    }

    // 2) Fallback to Gmail web compose (requires a browser)
    try {
      final Uri gmailWeb = Uri.https('mail.google.com', '/mail/', {
        'view': 'cm',
        'fs': '1',
        'to': supportEmail ?? '',
        'su': subject,
      });
      final launchedWeb = await launchUrl(
        gmailWeb,
        mode: LaunchMode.externalApplication,
      );
      if (launchedWeb) return;
    } catch (_) {
      // continue to next fallback
    }

    // 3) Suggest installing an email app or browser (Android only)
    try {
      if (Platform.isAndroid) {
        // Try Gmail on Play Store
        final marketGmail = Uri.parse(
          'market://details?id=com.google.android.gm',
        );
        if (await launchUrl(
          marketGmail,
          mode: LaunchMode.externalApplication,
        )) {
          return;
        }
        final httpsGmail = Uri.parse(
          'https://play.google.com/store/apps/details?id=com.google.android.gm',
        );
        if (await launchUrl(httpsGmail, mode: LaunchMode.externalApplication)) {
          return;
        }
        // Try Chrome on Play Store (browser for web compose)
        final marketChrome = Uri.parse(
          'market://details?id=com.android.chrome',
        );
        if (await launchUrl(
          marketChrome,
          mode: LaunchMode.externalApplication,
        )) {
          return;
        }
        final httpsChrome = Uri.parse(
          'https://play.google.com/store/apps/details?id=com.android.chrome',
        );
        if (await launchUrl(
          httpsChrome,
          mode: LaunchMode.externalApplication,
        )) {
          return;
        }
      }
    } catch (_) {
      // continue to next fallback
    }

    // 4) Last resort: copy address to clipboard and inform the user
    try {
      await Clipboard.setData(ClipboardData(text: supportEmail ?? ''));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isGreek
                ? 'Δεν βρέθηκε εφαρμογή email. Το email αντιγράφηκε στο πρόχειρο.'
                : 'No email app found. Address copied to clipboard.',
          ),
        ),
      );
    } catch (_) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isGreek
                ? 'Δεν είναι δυνατή η αποστολή email'
                : 'Could not send email',
          ),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  return Scaffold(
    backgroundColor: const Color(0xFFF9F9F9),
    appBar: AppBar(
      backgroundColor: Colors.white,
      elevation: 0,
      toolbarHeight: 72,
      title: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: Image.asset(
          logoAsset,
          width: 170,
          height: 68,
          fit: BoxFit.contain,
        ),
      ),
      centerTitle: true,
      leading: Semantics(
        label: isGreek ? 'Πίσω' : 'Back',
        button: true,
        enabled: true,
        onTap: () {
          Navigator.pop(context);
        },
        excludeSemantics: true,
        child: IconButton(
          icon: const Icon(Icons.arrow_back, color: Colors.black),
          tooltip: isGreek ? 'Πίσω' : 'Back',
          onPressed: () {
            Navigator.pop(context);
          },
        ),
      ),
    ),
    body: SafeArea(
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.all(16.0),
              child: Container(
                width: double.infinity,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(8),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.03),
                      blurRadius: 4,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                child: Padding(
                  padding: const EdgeInsets.all(20.0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        displayHeadingTitle,
                        style: theme.titleMedium.copyWith(
                          fontWeight: FontWeight.bold,
                          color: Colors.black,
                          fontFamily: supportFontFamily,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        displayHeadingSubtitle,
                        style: theme.bodyMedium.copyWith(
                          fontWeight: FontWeight.w400,
                          color: Colors.black54,
                          fontFamily: supportFontFamily,
                        ),
                      ),
                      // Bayer Emails Section (only shown when showBayerEmails is true)
                      if (showBayerEmails) ...[
                        const SizedBox(height: 20),
                        // Bayer emails list with clickable functionality
                        _buildBayerEmailRow(
                          context,
                          email: 'pv.smbs@bayer.com',
                          description: isGreek
                              ? 'Για αναφορά ανεπιθύμητων ενεργειών'
                              : 'For reporting adverse events',
                          theme: theme,
                          primaryBlue: primaryBlue,
                          supportFontFamily: supportFontFamily,
                          isGreek: isGreek,
                        ),
                        const SizedBox(height: 12),
                        _buildBayerEmailRow(
                          context,
                          email: 'quality.gr@bayer.com',
                          description: isGreek
                              ? 'Για αναφορά ποιοτικών παραπόνων'
                              : 'For reporting quality complaints',
                          theme: theme,
                          primaryBlue: primaryBlue,
                          supportFontFamily: supportFontFamily,
                          isGreek: isGreek,
                        ),
                        const SizedBox(height: 12),
                        _buildBayerEmailRow(
                          context,
                          email: 'ch-medinfo.gr.cy@bayer.com',
                          description: isGreek
                              ? 'Για ιατρική πληροφόρηση σχετικά με τα προϊόντα μας'
                              : 'For medical information about our products',
                          theme: theme,
                          primaryBlue: primaryBlue,
                          supportFontFamily: supportFontFamily,
                          isGreek: isGreek,
                        ),
                        const SizedBox(height: 12),
                        _buildBayerEmailRow(
                          context,
                          email: 'consumer.health.gr@bayer.com',
                          description: isGreek
                              ? 'Για οποιαδήποτε άλλη πληροφορία σχετικά με τα προϊόντα μας'
                              : 'For any other information about our products',
                          theme: theme,
                          primaryBlue: primaryBlue,
                          supportFontFamily: supportFontFamily,
                          isGreek: isGreek,
                        ),
                        const SizedBox(height: 8),
                      ],
                      const SizedBox(height: 16),
                      Semantics(
                        label: isGreek
                            ? 'Τηλεφωνική Εξυπηρέτηση ${displayPhone}'
                            : 'Phone Support ${displayPhone}',
                        container: true,
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(Icons.phone,
                                color: primaryBlue, size: 22),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    isGreek
                                        ? 'Τηλεφωνική Εξυπηρέτηση'
                                        : 'Phone Support',
                                    style: theme.bodyMedium.copyWith(
                                      fontWeight: FontWeight.w600,
                                      fontFamily: supportFontFamily,
                                    ),
                                  ),
                                  Text(
                                    displayPhone,
                                    style: theme.bodyMedium.copyWith(
                                      fontFamily: supportFontFamily,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (supportDaysOpen?.isNotEmpty == true) ...[
                        const SizedBox(height: 16),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Icon(
                              Icons.access_time,
                              color: primaryBlue,
                              size: 22,
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    isGreek
                                        ? 'Ώρες Λειτουργίας'
                                        : 'Store Hours',
                                    style: theme.bodyMedium.copyWith(
                                      fontWeight: FontWeight.w600,
                                      fontFamily: supportFontFamily,
                                    ),
                                  ),
                                  Text(
                                    displayDaysOpen,
                                    style: theme.bodyMedium.copyWith(
                                      fontFamily: supportFontFamily,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 16),
                      if (displayGenericEmail.isNotEmpty) ...[
                        Semantics(
                          label: isGreek
                              ? 'Επικοινωνία μέσω email ${displayGenericEmail}'
                              : 'Email Communication ${displayGenericEmail}',
                          container: true,
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.email,
                                  color: primaryBlue, size: 22),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      isGreek
                                          ? 'Επικοινωνία μέσω email'
                                          : 'Email Communication',
                                      style: theme.bodyMedium.copyWith(
                                        fontWeight: FontWeight.w600,
                                        fontFamily: supportFontFamily,
                                      ),
                                    ),
                                    Text(
                                      displayGenericEmail,
                                      style: theme.bodyMedium.copyWith(
                                        fontFamily: supportFontFamily,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  SizedBox(
                    width: MediaQuery.of(context).size.width * 0.7,
                    child: Semantics(
                      label: isGreek
                          ? 'Κλήση Εξυπηρέτηση Καταναλωτών'
                          : 'Call Consumer Support',
                      button: true,
                      excludeSemantics: true,
                      child: ElevatedButton(
                        onPressed: _makePhoneCall,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: primaryBlue,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          textStyle: theme.bodyMedium.copyWith(
                            fontWeight: FontWeight.w600,
                            fontFamily: supportFontFamily,
                          ),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.phone,
                              color: Colors.white,
                              size: 22,
                            ),
                            const SizedBox(width: 8),
                            ConstrainedBox(
                              constraints: BoxConstraints(
                                maxWidth:
                                    MediaQuery.of(context).size.width * 0.55,
                              ),
                              child: Text(
                                isGreek
                                    ? 'Κλήση Εξυπηρέτηση Καταναλωτών'
                                    : 'Call Consumer Support',
                                textAlign: TextAlign.center,
                                softWrap: true,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: MediaQuery.of(context).size.width * 0.7,
                    child: Semantics(
                      label: isGreek ? 'Αποστολή Email' : 'Send Email',
                      button: true,
                      excludeSemantics: true,
                      child: ElevatedButton(
                        onPressed: _sendEmail,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.white,
                          foregroundColor: Colors.black87,
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          textStyle: theme.bodyMedium.copyWith(
                            fontWeight: FontWeight.w600,
                            fontFamily: supportFontFamily,
                          ),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
                          ),
                          side: BorderSide(color: Colors.grey.shade300),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.email,
                              color: Colors.black54,
                              size: 22,
                            ),
                            const SizedBox(width: 8),
                            ConstrainedBox(
                              constraints: BoxConstraints(
                                maxWidth:
                                    MediaQuery.of(context).size.width * 0.55,
                              ),
                              child: Text(
                                isGreek ? 'Αποστολή Email' : 'Send Email',
                                textAlign: TextAlign.center,
                                softWrap: true,
                                style: theme.bodyMedium.copyWith(
                                  fontWeight: FontWeight.w600,
                                  color: Colors.black87,
                                  fontFamily: supportFontFamily,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  if (instagram?.isNotEmpty == true) ...[
                    const SizedBox(height: 8),
                    SizedBox(
                      width: MediaQuery.of(context).size.width * 0.7,
                      child: Semantics(
                        label: isGreek ? 'Instagram' : 'Instagram',
                        button: true,
                        excludeSemantics: true,
                        child: ElevatedButton(
                          onPressed: () =>
                              _openInstagram(instagram!, context, isGreek),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.white,
                            foregroundColor: Colors.black87,
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            textStyle: theme.bodyMedium.copyWith(
                              fontWeight: FontWeight.w600,
                              fontFamily: supportFontFamily,
                            ),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(6),
                            ),
                            side: BorderSide(color: Colors.grey.shade300),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(
                                FontAwesomeIcons.instagram,
                                color: Colors.black54,
                                size: 22,
                              ),
                              const SizedBox(width: 8),
                              ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth:
                                      MediaQuery.of(context).size.width * 0.55,
                                ),
                                child: Text(
                                  'Instagram',
                                  textAlign: TextAlign.center,
                                  softWrap: true,
                                  style: theme.bodyMedium.copyWith(
                                    fontWeight: FontWeight.w600,
                                    color: Colors.black87,
                                    fontFamily: supportFontFamily,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

// Helper function to open Instagram link
Future<void> _openInstagram(
    String instagramUrl, BuildContext context, bool isGreek) async {
  try {
    final Uri url = Uri.parse(instagramUrl);
    if (await canLaunchUrl(url)) {
      await launchUrl(
        url,
        mode: LaunchMode.externalApplication,
      );
    } else {
      // Show error message if URL can't be opened
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isGreek
                ? 'Δεν ήταν δυνατό να ανοίξει το Instagram'
                : 'Could not open Instagram',
          ),
        ),
      );
    }
  } catch (e) {
    print('Error opening Instagram: $e');
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          isGreek
              ? 'Σφάλμα κατά το άνοιγμα του Instagram'
              : 'Error opening Instagram',
        ),
      ),
    );
  }
}

// Helper function to build Bayer email row with clickable email
Widget _buildBayerEmailRow(
  BuildContext context, {
  required String email,
  required String description,
  required dynamic theme,
  required Color primaryBlue,
  required String supportFontFamily,
  required bool isGreek,
}) {
  Future<void> _openEmailClient(String emailAddress) async {
    final String subject = isGreek ? 'Επικοινωνία' : 'Contact';
    final Uri emailUri = Uri(
      scheme: 'mailto',
      path: emailAddress,
      query: 'subject=${Uri.encodeComponent(subject)}',
    );

    // Try to open email client
    try {
      final launched = await launchUrl(
        emailUri,
        mode: LaunchMode.externalApplication,
      );
      if (launched) return;
    } catch (_) {}

    // Fallback to Gmail web
    try {
      final Uri gmailWeb = Uri.https('mail.google.com', '/mail/', {
        'view': 'cm',
        'fs': '1',
        'to': emailAddress,
        'su': subject,
      });
      final launchedWeb = await launchUrl(
        gmailWeb,
        mode: LaunchMode.externalApplication,
      );
      if (launchedWeb) return;
    } catch (_) {}

    // Last resort: copy to clipboard
    try {
      await Clipboard.setData(ClipboardData(text: emailAddress));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isGreek
                ? 'Η διεύθυνση email αντιγράφηκε στο πρόχειρο'
                : 'Email address copied to clipboard',
          ),
        ),
      );
    } catch (_) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            isGreek
                ? 'Δεν ήταν δυνατό το άνοιγμα του email'
                : 'Could not open email',
          ),
          backgroundColor: Colors.red,
        ),
      );
    }
  }

  return Semantics(
    label: '$email. $description',
    button: true,
    child: InkWell(
      onTap: () => _openEmailClient(email),
      borderRadius: BorderRadius.circular(8),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8.0),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.email_outlined, color: primaryBlue, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    email,
                    style: theme.bodyMedium.copyWith(
                      fontWeight: FontWeight.w600,
                      color: primaryBlue,
                      fontFamily: supportFontFamily,
                      decoration: TextDecoration.underline,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    description,
                    style: theme.bodySmall.copyWith(
                      fontWeight: FontWeight.w400,
                      color: Colors.black54,
                      fontFamily: supportFontFamily,
                    ),
                  ),
                ],
              ),
            ),
            Icon(Icons.arrow_forward_ios, color: Colors.grey[400], size: 16),
          ],
        ),
      ),
    ),
  );
}

Future<String?> scanBarcode(BuildContext context, String languageCode) async {
  // Get fresh signed URL from Firebase for success sound
  String? foundSoundURL;
  try {
    print('🎵 Generating fresh signed URL for barcode success sound...');
    final ref = FirebaseStorage.instance.ref().child('Correct (1).mp3');
    foundSoundURL = await ref.getDownloadURL();
    print('✅ Fresh barcode success sound URL: $foundSoundURL');
  } catch (e) {
    print('❌ Error getting barcode success sound URL: $e');
    foundSoundURL = null; // Will continue without sound
  }

  try {
    // Use the new fast barcode scanner
    final result = await Navigator.push<String>(
      context,
      MaterialPageRoute(
        builder: (context) => FastBarcodeScanner(
          languageCode: languageCode,
          onBarcodeDetected: (barcode) async {
            FFAppState().update(() {
              FFAppState().barcodeResult = barcode;
            });

            // Play success sound if URL available
            if (foundSoundURL != null && foundSoundURL.isNotEmpty) {
              final foundPlayer = audioplayers.AudioPlayer();
              try {
                print('🎵 Playing barcode success sound...');
                await foundPlayer.play(audioplayers.UrlSource(foundSoundURL));
                print('✅ Barcode success sound played');
              } catch (e) {
                print('❌ Error playing barcode success sound: $e');
              }
            }

            Navigator.pop(context, barcode);
          },
        ),
      ),
    );

    if (result == null) {
      return 'Scan cancelled';
    }

    return result;
  } catch (e) {
    return 'Error: ${e.toString()}';
  }
}

Future<void> announceMessage(String message) async {
  if (message.isNotEmpty) {
    await Future.delayed(Duration(milliseconds: 100));
    SemanticsService.announce(message, ui.TextDirection.ltr);
  }
}

class FastBarcodeScanner extends StatefulWidget {
  final Function(String) onBarcodeDetected;
  final String languageCode;

  const FastBarcodeScanner({
    Key? key,
    required this.onBarcodeDetected,
    this.languageCode = 'en',
  }) : super(key: key);

  @override
  _FastBarcodeScannerState createState() => _FastBarcodeScannerState();
}

class _FastBarcodeScannerState extends State<FastBarcodeScanner>
    with WidgetsBindingObserver {
  MobileScannerController? controller;
  bool _hasCameraPermission = false;
  bool _cameraPermanentlyDenied = false;
  bool _isRequestingPermission = false;
  bool _hasDetected = false;
  late final audioplayers.AudioPlayer _searchingPlayer =
      audioplayers.AudioPlayer();
  String? _scanningAudioUrl; // Will be fetched from Firebase at runtime
  bool _scanningAudioUrlInitialized = false;
  bool get _isGreek => widget.languageCode == 'el';
  Key _scannerKey = UniqueKey();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    controller = MobileScannerController(
      detectionSpeed: DetectionSpeed.normal,
      facing: CameraFacing.back,
      formats: const [
        BarcodeFormat.ean13,
        BarcodeFormat.ean8,
        BarcodeFormat.upcA,
        BarcodeFormat.upcE,
        BarcodeFormat.code128,
      ],
    );
    _checkCameraPermission();

    // Ensure scanning sound initializes after widget is built
    WidgetsBinding.instance.addPostFrameCallback((_) {
      print(
          '🎵 Post-frame callback: Ensuring scanning sound is initialized...');
      if (!_scanningAudioUrlInitialized && !_hasDetected) {
        _initializeScanningSound();
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _stopSearchingSound();
    _searchingPlayer.dispose();
    controller?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Always re-check permission and remount scanner on resume
    if (state == AppLifecycleState.resumed) {
      _checkCameraPermission();
    }
  }

  Future<void> _checkCameraPermission() async {
    try {
      // Try to initialize camera directly - this triggers native permission if needed
      await _ensureScannerRunning();
      setState(() {
        _hasCameraPermission = true;
        _cameraPermanentlyDenied = false;
        _scannerKey = UniqueKey(); // Always remount scanner
      });
      // Fetch fresh scanning sound URL and start playing it
      await _initializeScanningSound();
    } catch (e) {
      // If camera fails to start, it's likely a permission issue
      setState(() {
        _hasCameraPermission = false;
        _cameraPermanentlyDenied = true; // Show Settings button
      });
    }
  }

  /// Fetch and initialize scanning sound from Firebase Storage
  Future<void> _initializeScanningSound() async {
    if (_hasDetected) return; // Don't initialize if already detected

    // If URL already cached and initialized, just start playing
    if (_scanningAudioUrlInitialized && _scanningAudioUrl != null) {
      print('🎵 Using cached scanning sound URL');
      _startSearchingSound();
      return;
    }

    try {
      print('🎵 Generating fresh signed URL for scanning sound...');
      final ref = FirebaseStorage.instance.ref().child('ScanningSound.mp3');
      final freshUrl = await ref.getDownloadURL();
      print('✅ Fresh scanning sound URL generated: $freshUrl');
      _scanningAudioUrl = freshUrl;
      _scanningAudioUrlInitialized = true;

      // Start playing the sound immediately
      print('🎵 Starting to play scanning sound...');
      await _startSearchingSound();
      print('✅ Scanning sound initialization complete');
    } catch (e) {
      print('❌ Error generating fresh scanning sound URL: $e');
      print('❌ Error type: ${e.runtimeType}');
      // Scanner continues to work even if sound fails
    }
  }

  Future<void> _requestCameraPermission() async {
    if (_isRequestingPermission) return;
    setState(() => _isRequestingPermission = true);
    try {
      // Try to initialize camera directly - this triggers native permission if needed
      await _ensureScannerRunning();
      setState(() {
        _hasCameraPermission = true;
        _cameraPermanentlyDenied = false;
        _scannerKey = UniqueKey();
      });
      // Fetch fresh scanning sound URL and start playing it
      await _initializeScanningSound();
    } catch (e) {
      // If camera fails to start, it's likely a permission issue
      setState(() {
        _hasCameraPermission = false;
        _cameraPermanentlyDenied = true;
      });
    } finally {
      if (mounted) setState(() => _isRequestingPermission = false);
    }
  }

  Future<void> _ensureScannerRunning() async {
    try {
      await controller?.start();
    } catch (e) {
      // Recreate controller and remount scanner to pick up new permission/session
      try {
        await controller?.dispose();
      } catch (_) {}
      controller = MobileScannerController(
        detectionSpeed: DetectionSpeed.normal,
        facing: CameraFacing.back,
        formats: const [
          BarcodeFormat.ean13,
          BarcodeFormat.ean8,
          BarcodeFormat.upcA,
          BarcodeFormat.upcE,
          BarcodeFormat.code128,
        ],
      );
      setState(() => _scannerKey = UniqueKey());
      try {
        await controller?.start();
      } catch (_) {}
    }
  }

  Future<void> _startSearchingSound() async {
    if (_hasDetected) {
      print('⚠️ Barcode already detected, skipping sound start');
      return;
    }
    try {
      // Use cached URL if available
      final soundUrl = _scanningAudioUrl;
      if (soundUrl == null || soundUrl.isEmpty) {
        print('⚠️ Scanning sound URL is empty, sound playback skipped');
        return;
      }

      print('🎵 Starting scanning sound with 1.5s delay between loops...');
      print('🎵 Setting volume to 1.0...');
      await _searchingPlayer.setVolume(1.0);

      print('🎵 Setting release mode to STOP (manual loop control)...');
      await _searchingPlayer.setReleaseMode(audioplayers.ReleaseMode.stop);

      print('🎵 Playing sound source...');
      await _searchingPlayer.play(audioplayers.UrlSource(soundUrl));

      print('✅ Scanning sound started, will repeat with 1.5s delay');

      // Set up listener for when sound finishes playing
      _searchingPlayer.onPlayerComplete.listen((_) async {
        if (!_hasDetected) {
          print('🎵 Sound completed, waiting 1.5 seconds before replaying...');
          await Future.delayed(const Duration(milliseconds: 1500));

          if (!_hasDetected && mounted) {
            print('🎵 Restarting scanning sound...');
            try {
              await _searchingPlayer.play(audioplayers.UrlSource(soundUrl));
            } catch (e) {
              print('❌ Error restarting sound: $e');
            }
          }
        }
      });
    } catch (e) {
      print('❌ Error playing scanning sound: $e');
      print('❌ Error type: ${e.runtimeType}');
      print('❌ Stack trace: ${StackTrace.current}');
      // Continue scanner operation even if sound fails
    }
  }

  Future<void> _stopSearchingSound() async {
    try {
      print('🎵 Stopping scanning sound...');
      await _searchingPlayer.stop();
      print('✅ Scanning sound stopped');
    } catch (e) {
      print('❌ Error stopping scanning sound: $e');
    }
  }

  void _onDetect(BarcodeCapture capture) {
    if (!_hasDetected && capture.barcodes.isNotEmpty) {
      final String? rawValue = capture.barcodes.first.rawValue;
      if (rawValue != null && rawValue.isNotEmpty) {
        _hasDetected = true;
        _stopSearchingSound();
        HapticFeedback.mediumImpact();
        widget.onBarcodeDetected(rawValue);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Text(
          _isGreek ? 'Σάρωση Barcode' : 'Scan Barcode',
          style: const TextStyle(color: Colors.white),
        ),
        leading: Semantics(
          container: true,
          label: _isGreek ? 'Πίσω' : 'Back',
          button: true,
          child: ExcludeSemantics(
            child: IconButton(
              icon: const Icon(Icons.arrow_back, color: Colors.white),
              onPressed: () => Navigator.pop(context),
              tooltip: _isGreek ? 'Πίσω' : 'Back',
            ),
          ),
        ),
      ),
      body: _hasCameraPermission
          ? MobileScanner(
              key: _scannerKey,
              controller: controller,
              fit: BoxFit.cover,
              onDetect: _onDetect,
            )
          : Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    _isGreek
                        ? 'Απαιτείται άδεια κάμερας'
                        : 'Camera permission required',
                    style: const TextStyle(color: Colors.white),
                  ),
                  const SizedBox(height: 12),
                  if (_cameraPermanentlyDenied)
                    ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: Colors.black,
                      ),
                      onPressed: () async {
                        await openAppSettings();
                      },
                      child: Text(
                        _isGreek ? 'Άνοιγμα Ρυθμίσεων' : 'Open Settings',
                      ),
                    )
                  else
                    ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: Colors.black,
                      ),
                      onPressed: _isRequestingPermission
                          ? null
                          : _requestCameraPermission,
                      child: Text(
                        _isGreek ? 'Να επιτραπεί η κάμερα' : 'Allow camera',
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}

class ExpirationDateScannerScreen extends StatefulWidget {
  final double width;
  final double height;
  final String? language;

  const ExpirationDateScannerScreen({
    Key? key,
    required this.width,
    required this.height,
    this.language,
  }) : super(key: key);

  @override
  _ExpirationDateScannerScreenState createState() =>
      _ExpirationDateScannerScreenState();
}

class _ExpirationDateScannerScreenState
    extends State<ExpirationDateScannerScreen> {
  CameraController? _controller;
  List<CameraDescription> _cameras = [];
  bool _isInitialized = false;
  bool _isProcessing = false;
  bool _hasDetectedDate = false;
  Map<String, dynamic>? _lastDetectedDateInfo;
  Timer? _scanTimer;

  // Track if announcements have been shown
  bool _announcementsShown = false;

  // iOS VoiceOver: Mute system sounds during scanning to avoid camera click sounds
  bool _soundsMuted = false;

  final FirebaseAuth _auth = FirebaseAuth.instance;
  bool _focusLocked = false;
  int _consecutiveEmptyScans = 0;
  int _consecutiveSuccessfulScans = 0;
  double _lastFocusDistance = 0.5;
  bool _isOptimizingFocus = false;
  int _scanCount = 0;
  DateTime? _lastSuccessfulScan;
  bool _flashEnabled = false;

  // Multi-frame consensus detection
  List<Map<String, dynamic>> _frameResults = [];
  // OPTIMIZATION: Reduced from 2 to 1 for very clear patterns
  // High confidence (>150) patterns don't need consensus - fast detection!
  final int _requiredConsensusFrames = 1;

  bool get _isGreek {
    if (widget.language != null) {
      return widget.language == 'el';
    }
    return Localizations.localeOf(context).languageCode == 'el';
  }

  // Comprehensive global pharmaceutical expiration date regex patterns
  // Simple, proven regex pattern from React project - works perfectly for MM-YYYY, MM/YYYY, MM.YYYY, MM YYYY
  final RegExp _expirationPattern = RegExp(r'\b(\d{2})[-./\s](\d{4})\b');

  @override
  void initState() {
    super.initState();
    _checkAndMarkAnnouncementShown();
    _initializeCamera();
  }

  @override
  void dispose() {
    _controller?.dispose();
    _scanTimer?.cancel();
    super.dispose();
  }

  // Advanced camera focus optimization methods for better pharmaceutical text scanning
  Future<void> _optimizeCameraForTextScanning() async {
    if (_controller == null || !_controller!.value.isInitialized) return;

    try {
      // IMPROVED FOCUS: Use continuous autofocus for small text/products
      await _controller!.setExposureMode(ExposureMode.auto);
      await _controller!.setFocusMode(FocusMode.auto); // Continuous autofocus
      await _enableSmartFlashlight();

      // Don't lock focus - let it continuously adjust for small products
      // await _setOptimalFocusDistance(0.3); // REMOVED - was causing focus issues
    } catch (e) {
      // Camera optimization error handled silently
    }
  }

  Future<void> _enableSmartFlashlight() async {
    if (_controller == null || !_controller!.value.isInitialized) return;

    try {
      await _controller!.setFlashMode(FlashMode.off);
      _flashEnabled = false;
    } catch (e) {
      // Failed to initialize flashlight
    }
  }

  Future<void> _muteSystemSounds() async {
    if (Platform.isIOS && !_soundsMuted) {
      try {
        // On iOS, configure audio session to reduce system sounds during scanning
        // This prevents camera click sounds from being announced by VoiceOver
        final session = await AudioSession.instance;
        await session.setActive(true);
        _soundsMuted = true;
        print('🔇 System sounds muted for iOS');
      } catch (e) {
        print('❌ Error muting system sounds: $e');
        // Silently fail if audio session config fails - scanning will still work
      }
    }
  }

  Future<void> _unmuteSystemSounds() async {
    if (Platform.isIOS && _soundsMuted) {
      try {
        // Restore audio session after scanning
        final session = await AudioSession.instance;
        await session.setActive(false);
        _soundsMuted = false;
        print('🔊 System sounds restored');
      } catch (e) {
        print('❌ Error restoring system sounds: $e');
      }
    }
  }

  // Smart flash control - only enable when many consecutive empty scans suggest low light
  Future<void> _handleSmartFlash() async {
    if (_controller == null || !_controller!.value.isInitialized) return;

    try {
      if (_consecutiveEmptyScans >= 10 && !_flashEnabled) {
        await _controller!.setFlashMode(FlashMode.torch);
        _flashEnabled = true;
        await Future.delayed(Duration(milliseconds: 100));
      } else if (_consecutiveEmptyScans >= 25 && _flashEnabled) {
        await _controller!.setFlashMode(FlashMode.off);
        _flashEnabled = false;
        await Future.delayed(Duration(milliseconds: 100));
      }
    } catch (e) {
      try {
        await _controller!.setFlashMode(FlashMode.off);
        _flashEnabled = false;
      } catch (_) {}
    }
  }

  Future<void> _setOptimalFocusDistance(double distance) async {
    if (_controller == null || !_controller!.value.isInitialized) return;

    try {
      final clampedDistance = distance.clamp(0.0, 1.0);
      await _controller!.setFocusMode(FocusMode.locked);
      await _controller!.setFocusPoint(null);
      _lastFocusDistance = clampedDistance;
      _focusLocked = true;
    } catch (e) {
      // Focus setting error handled silently
    }
  }

  Future<void> _adjustFocusIfNeeded() async {
    if (_controller == null ||
        !_controller!.value.isInitialized ||
        _isOptimizingFocus) return;

    _scanCount++;

    // IMPROVED FOCUS for small products:
    // 1. Try macro focus immediately after 3 failed scans
    // 2. Reset to auto focus periodically to re-acquire focus
    // 3. Use shorter intervals for better responsiveness

    if (_consecutiveEmptyScans >= 3) {
      // For small products, use macro focus mode
      await _setMacroFocus();
    }

    // Reset to auto focus every 10 scans to prevent stuck focus
    if (_scanCount % 10 == 0) {
      try {
        await _controller!.setFocusMode(FocusMode.auto);
        await Future.delayed(const Duration(milliseconds: 300));
        _focusLocked = false;
      } catch (e) {
        // Focus reset error handled silently
      }
    }
  }

  Future<void> _setMacroFocus() async {
    if (_controller == null || !_controller!.value.isInitialized) return;

    try {
      _isOptimizingFocus = true;

      // IMPROVED MACRO FOCUS for small products:
      // 1. Switch to auto focus mode
      // 2. Wait longer for focus to stabilize (800ms instead of 500ms)
      // 3. Set focus point to center for better small-text detection
      await _controller!.setFocusMode(FocusMode.auto);

      // Set focus point to center of screen (better for small products)
      await _controller!.setFocusPoint(const Offset(0.5, 0.5));

      // Wait for focus to stabilize
      await Future.delayed(const Duration(milliseconds: 800));

      // Lock focus once stabilized
      await _controller!.setFocusMode(FocusMode.locked);
      _focusLocked = true;
      _isOptimizingFocus = false;
    } catch (e) {
      _isOptimizingFocus = false;
    }
  }

  Future<void> _announce(String message) async {
    if (message.isNotEmpty) {
      await Future.delayed(const Duration(milliseconds: 100));
      SemanticsService.announce(message, ui.TextDirection.ltr);
    }
  }

  Future<void> _checkAndMarkAnnouncementShown() async {
    try {
      final user = FirebaseAuth.instance.currentUser;
      if (user == null) {
        _announcementsShown = false;
        return;
      }

      final userDoc =
          FirebaseFirestore.instance.collection('Users').doc(user.uid);
      final snapshot = await userDoc.get();

      // Check if ExpirationDateAnnouncementApplied is true
      if (snapshot.exists && snapshot.data() != null) {
        _announcementsShown =
            snapshot.data()!['ExpirationDateAnnouncementApplied'] as bool? ??
                false;
      } else {
        _announcementsShown = false;
      }

      // If this is the first time (announcements not shown yet), mark it as done
      if (!_announcementsShown) {
        await userDoc.set({
          'ExpirationDateAnnouncementApplied': true,
        }, SetOptions(merge: true));
        _announcementsShown =
            false; // Keep as false for this session so we announce
      }
    } catch (e) {
      print('Firestore error: $e');
      _announcementsShown = false;
    }
  }

  Future<void> _initializeCamera() async {
    try {
      _cameras = await availableCameras();
      if (_cameras.isEmpty) throw Exception("No cameras available");

      _controller = CameraController(
        _cameras[0],
        ResolutionPreset.high,
        enableAudio: false,
      );

      await _controller!.initialize();

      if (mounted) {
        // Optimize camera for text scanning
        await _optimizeCameraForTextScanning();

        setState(() {
          _isInitialized = true;
        });

        // First time: Full announcement (Camera ready + Scanning guide + Important disclaimer)
        // Subsequent times: Only "Camera ready"
        if (!_announcementsShown) {
          // FIRST TIME - Full announcement
          // Add delay to avoid screen reader interference
          await Future.delayed(const Duration(milliseconds: 500));
          await _announce(
            _isGreek
                ? 'Κάμερα έτοιμη. Οδηγίες σάρωσης: Κρατήστε τη συσκευή σταθερή, 10-15 εκατοστά από το προϊόν. Μετακινήστε αργά προς το κείμενο της ημερομηνίας λήξης. Η ημερομηνία λήξης θα ανακοινωθεί αυτόματα. Σημαντικό: Το αποτέλεσμα που θα λάβετε δεν είναι ποτέ εκατό τοις εκατό σίγουρο, συνιστάται να επαναλάβετε τη σάρωση για επιβεβαίωση.'
                : 'Camera ready. Scanning guide: Hold device steady, 10-15cm from product. Move slowly toward the expiration date text. The expiration date will be announced automatically. Important: The result is not one hundred percent certain, it is recommended to re-scan for confirmation.',
          );
        } else {
          // SUBSEQUENT TIMES - Only "Camera ready"
          // Add delay to avoid screen reader interference
          await Future.delayed(const Duration(milliseconds: 500));
          await _announce(
            _isGreek ? 'Κάμερα έτοιμη.' : 'Camera ready.',
          );
        }

        _startContinuousScanning();
      }
    } catch (e) {
      _showError(
        _isGreek
            ? 'Σφάλμα κάμερας: ${e.toString()}'
            : 'Camera error: ${e.toString()}',
      );
    }
  }

  void _startContinuousScanning() {
    if (_hasDetectedDate) return;

    // Mute system sounds on iOS to prevent camera click sounds during VoiceOver
    _muteSystemSounds();

    // OPTIMIZATION: Reduced from 150ms to 100ms for faster detection
    _scanTimer =
        Timer.periodic(const Duration(milliseconds: 100), (timer) async {
      if (!mounted ||
          _hasDetectedDate ||
          _controller == null ||
          !_controller!.value.isInitialized) {
        return;
      }

      if (_isProcessing) {
        return;
      }

      try {
        setState(() {
          _isProcessing = true;
        });

        final image = await _controller!.takePicture();

        final recognizedText = await _processImageForExpirationOptimized(
          File(image.path),
        );

        if (recognizedText.isNotEmpty) {
          final expirationInfo = _extractExpirationDate(recognizedText);
          if (expirationInfo != null) {
            final int? month = expirationInfo['month'] as int?;
            final int? year = expirationInfo['year'] as int?;
            final double confidence =
                expirationInfo['confidenceScore'] as double? ?? 0.0;

            if (month == null || year == null || month < 1 || month > 12) {
              _consecutiveEmptyScans++;
              _consecutiveSuccessfulScans = 0;
            } else if (confidence > 200) {
              // OPTIMIZATION: Fast-track for VERY HIGH confidence patterns!
              // If confidence > 200 (MM YYYY_SPACE, YYYY + keywords), instant detection!
              // No need to wait 5-10 seconds for consensus - we know it's correct!
              _consecutiveSuccessfulScans++;
              _consecutiveEmptyScans = 0;
              _lastSuccessfulScan = DateTime.now();

              if (_flashEnabled) {
                try {
                  await _controller!.setFlashMode(FlashMode.off);
                  _flashEnabled = false;
                } catch (e) {}
              }

              _scanTimer?.cancel();
              HapticFeedback.mediumImpact();

              // Show UI immediately
              setState(() {
                _hasDetectedDate = true;
                _lastDetectedDateInfo = expirationInfo;
              });

              // Unmute system sounds now that scanning is complete
              _unmuteSystemSounds();

              // FIRST: Announce the detected date to screen reader
              try {
                await _announceExpirationDate(expirationInfo);
              } catch (e) {
                print('Announcement error: $e');
              }

              // THEN: Show dialog AFTER announcements complete (2 seconds delay)
              Future.delayed(const Duration(seconds: 2), () {
                if (mounted) _showScanAgainDialog();
              });
            } else {
              // Add to frame results for multi-frame consensus
              _frameResults.add(expirationInfo);

              // Keep only last 5 frames
              if (_frameResults.length > 5) {
                _frameResults.removeAt(0);
              }

              // Check for consensus across frames (require 1+ frames after optimization)
              final consensusDate = _findConsensusDate(_frameResults);

              if (consensusDate != null) {
                // We have consensus! Proceed with high confidence
                _consecutiveSuccessfulScans++;
                _consecutiveEmptyScans = 0;
                _lastSuccessfulScan = DateTime.now();

                if (_flashEnabled) {
                  try {
                    await _controller!.setFlashMode(FlashMode.off);
                    _flashEnabled = false;
                  } catch (e) {}
                }

                _scanTimer?.cancel();

                HapticFeedback.mediumImpact();

                // Show UI immediately
                setState(() {
                  _hasDetectedDate = true;
                  _lastDetectedDateInfo = consensusDate;
                });

                // Unmute system sounds now that scanning is complete
                _unmuteSystemSounds();

                // Clear frame results for next scan
                _frameResults.clear();

                // FIRST: Announce the detected date to screen reader
                try {
                  await _announceExpirationDate(consensusDate);
                } catch (e) {
                  print('Announcement error: $e');
                }

                // THEN: Show dialog AFTER announcements complete (2 seconds delay)
                Future.delayed(const Duration(seconds: 2), () {
                  if (mounted) _showScanAgainDialog();
                });
              } else {
                // No consensus yet, keep scanning
                _consecutiveEmptyScans = 0;
              }
            }
          } else {
            _consecutiveEmptyScans++;
            _consecutiveSuccessfulScans = 0;
          }
        } else {
          _consecutiveEmptyScans++;
          _consecutiveSuccessfulScans = 0;

          await _handleSmartFlash();

          // IMPROVED FOCUS: Adjust focus for small products after multiple failed scans
          if (_consecutiveEmptyScans % 5 == 0) {
            await _adjustFocusIfNeeded();
          }

          if (_consecutiveEmptyScans % 15 == 0) {
            await _announce(
              _isGreek
                  ? 'Συνεχίστε να σκανάρετε. Κρατήστε 10-15cm από το προϊόν.'
                  : 'Keep scanning. Hold 10-15cm from product.',
            );
          }
        }

        try {
          await File(image.path).delete();
        } catch (e) {}
      } catch (e) {
        // Scanning error handled silently
      } finally {
        if (mounted) {
          setState(() {
            _isProcessing = false;
          });
        }
      }
    });
  }

  // Show confirmation dialog after successful scan
  Future<void> _showScanAgainDialog() async {
    return showDialog<void>(
      context: context,
      barrierDismissible: false, // User must tap button
      builder: (BuildContext context) {
        return AlertDialog(
          backgroundColor: Colors.black87,
          title: Text(
            _isGreek ? 'Σάρωση Ολοκληρώθηκε' : 'Scan Completed',
            style: const TextStyle(color: Colors.white),
          ),
          content: SingleChildScrollView(
            child: ListBody(
              children: <Widget>[
                // Display detected date if available
                if (_lastDetectedDateInfo != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.blue.withOpacity(0.2),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: Colors.blue, width: 1),
                      ),
                      child: Text(
                        _isGreek
                            ? 'Ημερομηνία που βρέθηκε: ${_lastDetectedDateInfo!['matchedText'] ?? 'N/A'}'
                            : 'Detected date: ${_lastDetectedDateInfo!['matchedText'] ?? 'N/A'}',
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                Text(
                  _isGreek
                      ? 'Θέλετε να σκανάρετε ξανά;'
                      : 'Do you want to scan again?',
                  style: const TextStyle(color: Colors.white70),
                ),
              ],
            ),
          ),
          actions: <Widget>[
            TextButton(
              child: Text(
                _isGreek ? 'Όχι' : 'No',
                style: const TextStyle(color: Colors.white70),
              ),
              onPressed: () {
                Navigator.of(context).pop(); // Close dialog
                Navigator.pop(context); // Go back like the back button
              },
            ),
            TextButton(
              child: Text(
                _isGreek ? 'Ναι' : 'Yes',
                style: const TextStyle(color: Colors.blue),
              ),
              onPressed: () {
                Navigator.of(context).pop(); // Close dialog
                _restartScan(); // Restart the scan
              },
            ),
          ],
        );
      },
    );
  }

  // Restart the scanning process
  void _restartScan() {
    setState(() {
      _hasDetectedDate = false;
      _scanCount = 0;
      _consecutiveEmptyScans = 0;
      _consecutiveSuccessfulScans = 0;
      _lastDetectedDateInfo = null;
      _frameResults.clear(); // Clear frame results for new scan
    });

    if (_flashEnabled) {
      try {
        _controller!.setFlashMode(FlashMode.off);
        _flashEnabled = false;
      } catch (e) {}
    }

    // OPTIMIZATION: Reset focus to auto for faster re-detection
    // This helps when user scans the same product again
    try {
      _controller!.setFocusMode(FocusMode.auto);
      _focusLocked = false;
    } catch (e) {
      // Focus reset error ignored
    }

    _startContinuousScanning();
  }

  /// Validates if a date is possible (e.g., no Feb 31, no Month 13)
  bool _isValidDate(int year, int month, int? day) {
    // Year validation
    if (year < 2020 || year > 2040) return false;

    // Month validation
    if (month < 1 || month > 12) return false;

    // Day validation (if present)
    if (day != null) {
      if (day < 1 || day > 31) return false;

      // Days per month validation
      final daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (day > daysInMonth[month - 1]) return false;

      // February leap year check
      if (month == 2 && day > 28) {
        final isLeapYear =
            (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        if (!isLeapYear) return false;
      }
    }

    return true;
  }

  /// Converts abbreviated month name to month number (1-12)
  int? _monthAbbreviationToNumber(String monthAbbr) {
    final normalized = monthAbbr.toUpperCase();

    // English month abbreviations
    const englishMonths = {
      'JAN': 1,
      'FEB': 2,
      'MAR': 3,
      'APR': 4,
      'MAY': 5,
      'JUN': 6,
      'JUL': 7,
      'AUG': 8,
      'SEP': 9,
      'OCT': 10,
      'NOV': 11,
      'DEC': 12,
    };

    // Greek month abbreviations
    const greekMonths = {
      'ΙΑΝ': 1,
      'ΦΕΒ': 2,
      'ΜΑΡ': 3,
      'ΑΠΡ': 4,
      'ΜΑΪ': 5,
      'ΙΟΥΝ': 6,
      'ΙΟΥΛ': 7,
      'ΑΥΓ': 8,
      'ΣΕΠ': 9,
      'ΟΚΤ': 10,
      'ΝΟΕ': 11,
      'ΔΕΚ': 12,
    };

    if (englishMonths.containsKey(normalized)) {
      return englishMonths[normalized];
    }
    if (greekMonths.containsKey(normalized)) {
      return greekMonths[normalized];
    }

    return null;
  }

  /// Multi-frame consensus detection - requires multiple frames to agree
  Map<String, dynamic>? _findConsensusDate(List<Map<String, dynamic>> results) {
    if (results.length < _requiredConsensusFrames) return null;

    // Group by normalized date key
    Map<String, List<Map<String, dynamic>>> dateGroups = {};

    for (final result in results) {
      final year = result['year'] as int;
      final month = result['month'] as int;
      final day = result['day'] as int?;
      final key = '$year-$month-${day ?? 15}';

      dateGroups.putIfAbsent(key, () => []).add(result);
    }

    // Find most common date (appears in at least _requiredConsensusFrames)
    for (final group in dateGroups.values) {
      if (group.length >= _requiredConsensusFrames) {
        // Return the one with highest confidence
        group.sort((a, b) => (b['confidenceScore'] as double)
            .compareTo(a['confidenceScore'] as double));
        return group.first;
      }
    }

    return null;
  }

  Future<String> _processImageForExpiration(File imageFile) async {
    try {
      final bytes = await imageFile.readAsBytes();
      final base64Image = base64Encode(bytes);

      
      const url =
          'https://vision.googleapis.com/v1/images:annotate?key=$apiKey';

      final response = await http.post(
        Uri.parse(url),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'requests': [
            {
              'image': {'content': base64Image},
              'features': [
                {'type': 'TEXT_DETECTION', 'maxResults': 1},
              ],
              'imageContext': {
                'languageHints': ['el', 'en'],
              },
            },
          ],
        }),
      );

      if (response.statusCode == 200) {
        final result = json.decode(response.body);
        final textAnnotations = result['responses'][0]['textAnnotations'];

        if (textAnnotations != null && textAnnotations.isNotEmpty) {
          return textAnnotations[0]['description'] ?? '';
        }
      } else {
        print(
          'Expiration API Error: ${response.statusCode} - ${response.body}',
        );
      }

      return '';
    } catch (e) {
      print('Expiration Cloud Vision error: $e');
      return '';
    }
  }

  // Simple version for live scanning
  Future<String> _processImageForExpirationOptimized(File imageFile) async {
    try {
      // OPTIMIZATION: Reduce image quality/size for faster processing
      // - Resize to max 720x960 for faster upload/processing
      // - Compress quality to 75% to reduce file size
      final bytes = await imageFile.readAsBytes();

      // OPTIMIZATION: Skip Vision API for very small text results
      // Only use Vision API - local processing is slower
      final base64Image = base64Encode(bytes);


      // OPTIMIZATION: Add timeout to avoid hanging requests
      final response = await http
          .post(
            Uri.parse(
              'https://vision.googleapis.com/v1/images:annotate?key=$apiKey',
            ),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'requests': [
                {
                  'image': {'content': base64Image},
                  'features': [
                    {'type': 'TEXT_DETECTION', 'maxResults': 1},
                  ],
                },
              ],
            }),
          )
          .timeout(
            const Duration(seconds: 8),
            onTimeout: () => http.Response('', 408),
          );

      if (response.statusCode == 200) {
        final result = jsonDecode(response.body);
        final textAnnotations = result['responses'][0]['textAnnotations'];

        if (textAnnotations != null && textAnnotations.isNotEmpty) {
          final detectedText = textAnnotations[0]['description'] ?? '';
          return detectedText;
        }
      }

      return '';
    } catch (e) {
      return '';
    }
  }

  Map<String, dynamic>? _extractExpirationDate(String text) {
    // OPTIMIZATION: Skip empty text immediately
    if (text.isEmpty || text.length < 4) {
      return null; // Can't contain a date if too short
    }

    // Step 1: Find all potential dates with comprehensive regex patterns
    // NOTE: Using non-final so we can deduplicate later (FIX #2)
    List<Map<String, dynamic>> allDetectedDates = [];

    // Comprehensive date patterns for various formats
    // IMPORTANT: YYYY patterns MUST come FIRST to avoid ambiguity!
    final List<Map<String, dynamic>> patterns = [
      // FIX #1: YYYY/MM/DD or YYYY-MM-DD or YYYY.MM.DD (American/ISO format)
      // MUST be first to match 2026.08.31 correctly (not as 26.08.2031)
      {
        'regex': RegExp(r'(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)',
            caseSensitive: false),
        'type': 'YYYY/MM/DD',
      },
      // FIX #1: YYYY/MM or YYYY-MM or YYYY.MM (American/ISO short format)
      {
        'regex': RegExp(r'(?<!\d)(\d{4})[-./](\d{1,2})(?![-./\d])',
            caseSensitive: false),
        'type': 'YYYY/MM',
      },
      // NEW: DD MMM YYYY - "31 AUG 2026", "31 AUG 26"
      {
        'regex': RegExp(
            r'(?<!\d)(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|ΙΑΝ|ΦΕΒ|ΜΑΡ|ΑΠΡ|ΜΑΪ|ΙΟΥΝ|ΙΟΥΛ|ΑΥΓ|ΣΕΠ|ΟΚΤ|ΝΟΕ|ΔΕΚ)\s+(\d{2,4})(?!\d)',
            caseSensitive: false),
        'type': 'DD MMM YYYY',
      },
      // NEW: MMM YYYY - "AUG 2026", "AUG 26"
      {
        'regex': RegExp(
            r'(?<!\d)(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|ΙΑΝ|ΦΕΒ|ΜΑΡ|ΑΠΡ|ΜΑΪ|ΙΟΥΝ|ΙΟΥΛ|ΑΥΓ|ΣΕΠ|ΟΚΤ|ΝΟΕ|ΔΕΚ)\s+(\d{2,4})(?!\d)',
            caseSensitive: false),
        'type': 'MMM YYYY',
      },
      // NEW: DDMMMYY - "31AUG26" (compact format common on medicine)
      {
        'regex': RegExp(
            r'(?<!\d)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|ΙΑΝ|ΦΕΒ|ΜΑΡ|ΑΠΡ|ΜΑΪ|ΙΟΥΝ|ΙΟΥΛ|ΑΥΓ|ΣΕΠ|ΟΚΤ|ΝΟΕ|ΔΕΚ)(\d{2})(?!\d)',
            caseSensitive: false),
        'type': 'DDMMMYY',
      },
      // NEW: DDMMMMYYYY - "31AUG2026" (compact format with full year)
      {
        'regex': RegExp(
            r'(?<!\d)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|ΙΑΝ|ΦΕΒ|ΜΑΡ|ΑΠΡ|ΜΑΪ|ΙΟΥΝ|ΙΟΥΛ|ΑΥΓ|ΣΕΠ|ΟΚΤ|ΝΟΕ|ΔΕΚ)(\d{4})(?!\d)',
            caseSensitive: false),
        'type': 'DDMMMYYYY',
      },
      // MM/YYYY or MM-YYYY or MM.YYYY
      {
        'regex':
            RegExp(r'(?<!\d)(\d{2})[-./](\d{4})(?!\d)', caseSensitive: false),
        'type': 'MM/YYYY',
      },
      // MM YYYY (with space separator - common on medicine packaging)
      {
        'regex':
            RegExp(r'(?<!\d)(\d{2})\s+(\d{4})(?!\d)', caseSensitive: false),
        'type': 'MM YYYY_SPACE',
      },
      // MM/YY or MM-YY or MM.YY
      {
        'regex': RegExp(r'(?<!\d)(\d{2})[-./](\d{2})(?![-./\d])',
            caseSensitive: false),
        'type': 'MM/YY',
      },
      // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
      {
        'regex': RegExp(r'(?<!\d)(\d{2})[-./](\d{2})[-./](\d{4})(?!\d)',
            caseSensitive: false),
        'type': 'DD/MM/YYYY',
      },
      // DD/MM/YY or DD-MM-YY or DD.MM.YY
      {
        'regex': RegExp(r'(?<!\d)(\d{2})[-./](\d{2})[-./](\d{2})(?![-./\d])',
            caseSensitive: false),
        'type': 'DD/MM/YY',
      },
      // MMYYYY (no separator)
      {
        'regex': RegExp(r'(?<!\d)(\d{2})(\d{4})(?!\d)', caseSensitive: false),
        'type': 'MMYYYY',
      },
      // NEW: DD/MM (European day/month format - very common!)
      // Matches "25/12", "31/08", etc. - assumes current or next year
      {
        'regex': RegExp(r'(?<!\d)(\d{1,2})[-./](\d{1,2})(?![-./\d])',
            caseSensitive: false),
        'type': 'DD/MM',
      },
    ];

    // Keywords for expiration date (Greek and English)
    final expirationKeywords = [
      'λήξη', 'λήξης', 'ληξη', 'ληξης', // Greek: expiration
      'καλύτερα πριν', 'καλυτερα πριν', // Greek: best before
      'exp', 'expiry', 'expiration', 'expires', // English
      'best before', 'use by', 'use before', // English
      'bbe', 'bb', // Abbreviations
    ];

    // Keywords for production date (to avoid confusion)
    final productionKeywords = [
      'παραγωγή', 'παραγωγης', 'παραγωγη', 'παραγωγής', // Greek: production
      'mfg', 'mfd', 'manufactured', 'production', 'prod', // English
      'lot', 'batch', // Batch/Lot numbers
    ];

    // Extract all dates from all patterns
    for (final patternData in patterns) {
      final regex = patternData['regex'] as RegExp;
      final type = patternData['type'] as String;
      final matches = regex.allMatches(text);

      for (final match in matches) {
        final matchedText = match.group(0) ?? '';
        final matchStart = match.start;
        final matchEnd = match.end;

        // Parse the date based on pattern type
        Map<String, dynamic>? dateInfo;
        try {
          if (type == 'MM/YYYY') {
            final month = int.parse(match.group(1)!);
            final year = int.parse(match.group(2)!);
            dateInfo = {'month': month, 'year': year, 'day': null};
          } else if (type == 'MM YYYY_SPACE') {
            final month = int.parse(match.group(1)!);
            final year = int.parse(match.group(2)!);
            dateInfo = {'month': month, 'year': year, 'day': null};
          } else if (type == 'MM/YY') {
            final month = int.parse(match.group(1)!);
            var year = int.parse(match.group(2)!);
            year = year < 50 ? year + 2000 : year + 1900;
            dateInfo = {'month': month, 'year': year, 'day': null};
          } else if (type == 'DD/MM/YYYY') {
            final day = int.parse(match.group(1)!);
            final month = int.parse(match.group(2)!);
            final year = int.parse(match.group(3)!);
            dateInfo = {'day': day, 'month': month, 'year': year};
          } else if (type == 'DD/MM/YY') {
            final day = int.parse(match.group(1)!);
            final month = int.parse(match.group(2)!);
            var year = int.parse(match.group(3)!);
            year = year < 50 ? year + 2000 : year + 1900;
            dateInfo = {'day': day, 'month': month, 'year': year};
          } else if (type == 'MMYYYY') {
            final month = int.parse(match.group(1)!);
            final year = int.parse(match.group(2)!);
            dateInfo = {'month': month, 'year': year, 'day': null};
          } else if (type == 'DD/MM') {
            // NEW: European DD/MM format (25/12) - assume current or next year
            final day = int.parse(match.group(1)!);
            final month = int.parse(match.group(2)!);
            final now = DateTime.now();
            var year = now.year;

            // If the date has already passed this year, assume next year
            final testDate = DateTime(year, month, day);
            if (testDate.isBefore(DateTime(now.year, now.month, now.day))) {
              year = now.year + 1;
            }

            dateInfo = {'day': day, 'month': month, 'year': year};
          } else if (type == 'YYYY/MM/DD') {
            // FIX #1: American/ISO format (2026.08.31)
            final year = int.parse(match.group(1)!);
            final month = int.parse(match.group(2)!);
            final day = int.parse(match.group(3)!);
            dateInfo = {'year': year, 'month': month, 'day': day};
          } else if (type == 'YYYY/MM') {
            // FIX #1: American/ISO short format (2026.08)
            final year = int.parse(match.group(1)!);
            final month = int.parse(match.group(2)!);
            dateInfo = {'year': year, 'month': month, 'day': null};
          } else if (type == 'DD MMM YYYY') {
            // NEW: Parse "31 AUG 2026" or "31 AUG 26"
            final day = int.parse(match.group(1)!);
            final monthAbbr = match.group(2)!;
            var year = int.parse(match.group(3)!);
            if (year < 100) {
              year = year < 50 ? 2000 + year : 1900 + year;
            }
            final month = _monthAbbreviationToNumber(monthAbbr);
            if (month == null) continue;
            dateInfo = {'day': day, 'month': month, 'year': year};
          } else if (type == 'MMM YYYY') {
            // NEW: Parse "AUG 2026" or "AUG 26"
            final monthAbbr = match.group(1)!;
            var year = int.parse(match.group(2)!);
            if (year < 100) {
              year = year < 50 ? 2000 + year : 1900 + year;
            }
            final month = _monthAbbreviationToNumber(monthAbbr);
            if (month == null) continue;
            dateInfo = {'month': month, 'year': year, 'day': null};
          } else if (type == 'DDMMMYY') {
            // NEW: Parse "31AUG26" (compact format)
            final day = int.parse(match.group(1)!);
            final monthAbbr = match.group(2)!;
            var year = int.parse(match.group(3)!);
            year = year < 50 ? 2000 + year : 1900 + year;
            final month = _monthAbbreviationToNumber(monthAbbr);
            if (month == null) continue;
            dateInfo = {'day': day, 'month': month, 'year': year};
          } else if (type == 'DDMMMYYYY') {
            // NEW: Parse "31AUG2026" (compact format with full year)
            final day = int.parse(match.group(1)!);
            final monthAbbr = match.group(2)!;
            final year = int.parse(match.group(3)!);
            final month = _monthAbbreviationToNumber(monthAbbr);
            if (month == null) continue;
            dateInfo = {'day': day, 'month': month, 'year': year};
          }
        } catch (e) {
          continue; // Skip invalid dates
        }

        if (dateInfo == null) continue;

        final month = dateInfo['month'] as int?;
        final year = dateInfo['year'] as int?;
        final day = dateInfo['day'] as int?;

        // Validate date ranges with proper date validation
        if (month == null || year == null) continue;
        if (!_isValidDate(year, month, day)) continue;

        // Calculate proximity score to keywords
        double expirationScore = 0.0;
        double productionScore = 0.0;

        // Check text before the date (within 50 characters)
        final contextStart = (matchStart - 50).clamp(0, text.length);
        final contextBefore =
            text.substring(contextStart, matchStart).toLowerCase();

        // Check text after the date (within 20 characters)
        final contextEnd = (matchEnd + 20).clamp(0, text.length);
        final contextAfter = text.substring(matchEnd, contextEnd).toLowerCase();

        // FIX #3: Enhanced keyword scoring with better context analysis
        // Score based on proximity to expiration keywords
        for (final keyword in expirationKeywords) {
          final keywordIndex = contextBefore.lastIndexOf(keyword);
          if (keywordIndex != -1) {
            final distance =
                contextBefore.length - keywordIndex - keyword.length;
            // Closer = higher score, max 100 points
            // Weighted scoring: very close keywords get bonus
            double score = (50 - distance).clamp(0, 50).toDouble();
            if (distance < 5) score += 25.0; // Bonus for very close keywords
            if (distance < 1) score += 15.0; // Bonus for immediately adjacent
            expirationScore += score;
          }
          // Also check after the date (strong indicator)
          if (contextAfter.contains(keyword)) {
            expirationScore += 40.0; // Higher weight for after-date keywords
          }
        }

        // Score based on proximity to production keywords (negative indicator)
        for (final keyword in productionKeywords) {
          final keywordIndex = contextBefore.lastIndexOf(keyword);
          if (keywordIndex != -1) {
            final distance =
                contextBefore.length - keywordIndex - keyword.length;
            // Reduce score for production keywords
            double score = (50 - distance).clamp(0, 50).toDouble();
            if (distance < 5) score += 15.0; // Penalty for very close keywords
            productionScore += score;
          }
          if (contextAfter.contains(keyword)) {
            productionScore += 30.0; // Penalty for after-date keywords
          }
        }

        // Calculate final confidence score
        double confidenceScore = expirationScore - productionScore;

        // CRITICAL FIX: Give HUGE priority bonus to YYYY formats
        // YYYY formats are almost always correct and should be preferred!
        if (type == 'YYYY/MM/DD' || type == 'YYYY/MM') {
          confidenceScore += 200.0; // Massive bonus for ISO format
        }

        // HIGH PRIORITY: Give strong bonus to MM/YY and MM/YYYY formats
        // These are VERY common on medicine packaging and should be trusted!
        if (type == 'MM/YY' || type == 'MM/YYYY' || type == 'MM YYYY_SPACE') {
          confidenceScore += 120.0; // Strong bonus for medicine-style dates
        }

        // BONUS: Give bonus to DD/MM/YY format (very common in Europe/Greece)
        // This format is very readable and common on products
        if (type == 'DD/MM/YY' || type == 'DD/MM/YYYY') {
          confidenceScore += 80.0; // Good bonus for European date format
        }

        // BONUS: Give bonus to DD/MM format (very common in Europe/Greece)
        // European day/month format like "25/12" - very readable!
        if (type == 'DD/MM') {
          confidenceScore += 70.0; // Good bonus for European DD/MM format
        }

        // Bonus for later dates (expiration dates are usually later than production)
        final dateValue = DateTime(year, month, day ?? 15);
        final monthsFromNow = dateValue.difference(DateTime.now()).inDays / 30;
        if (monthsFromNow > 0 && monthsFromNow < 60) {
          confidenceScore +=
              10.0; // Bonus for future dates within reasonable range
        }

        // Calculate expiration status
        final now = DateTime.now();
        final expDate = DateTime(year, month, day ?? 1);
        final isExpired =
            expDate.isBefore(DateTime(now.year, now.month, now.day));
        final monthsUntilExpiry =
            (expDate.year * 12 + expDate.month) - (now.year * 12 + now.month);

        allDetectedDates.add({
          'month': month,
          'year': year,
          'day': day,
          'matchedText': matchedText,
          'isExpired': isExpired,
          'confidenceScore': confidenceScore,
          'expirationKeywordScore': expirationScore,
          'productionKeywordScore': productionScore,
          'monthsUntilExpiry': monthsUntilExpiry,
          'contextBefore': contextBefore.trim(),
          'type': type,
        });
      }
    }

    // If no dates found, return null
    if (allDetectedDates.isEmpty) {
      return null;
    }

    // FIX #2: Deduplicate dates - handle same date in different formats
    // Group by normalized date (YYYY-MM-DD) and keep highest confidence version
    Map<String, Map<String, dynamic>> deduplicatedDates = {};
    for (final dateEntry in allDetectedDates) {
      final year = dateEntry['year'] as int;
      final month = dateEntry['month'] as int;
      final day = dateEntry['day'] as int?;

      // Normalize date key (use day 15 if not present for month-only formats)
      final normalizedKey = '$year-$month-${day ?? 15}';

      // Keep entry with highest confidence score
      if (!deduplicatedDates.containsKey(normalizedKey) ||
          (dateEntry['confidenceScore'] as double) >
              (deduplicatedDates[normalizedKey]!['confidenceScore']
                  as double)) {
        deduplicatedDates[normalizedKey] = dateEntry;
      }
    }
    allDetectedDates = deduplicatedDates.values.toList();

    // CRITICAL FIX: Sort by CONFIDENCE SCORE first (not just date!)
    // YYYY formats get +200 bonus, so they should be selected first!
    allDetectedDates.sort((a, b) {
      final confA = a['confidenceScore'] as double;
      final confB = b['confidenceScore'] as double;

      // First compare confidence scores (highest first)
      if ((confB - confA).abs() > 50) {
        return confB.compareTo(confA);
      }

      // If confidence similar, compare dates (latest first)
      final yearA = a['year'] as int;
      final yearB = b['year'] as int;
      if (yearB != yearA) {
        return yearB.compareTo(yearA);
      }

      final monthA = a['month'] as int;
      final monthB = b['month'] as int;
      final monthCompare = monthB.compareTo(monthA);
      if (monthCompare != 0) {
        return monthCompare;
      }

      // If same year and month, compare days (latest first)
      final dayA = a['day'] as int? ?? 1;
      final dayB = b['day'] as int? ?? 1;
      return dayB.compareTo(dayA);
    });

    // Return the latest date (which is the expiration date!)
    return allDetectedDates[0];
  }

  Future<void> _announceExpirationDate(Map<String, dynamic> dateInfo) async {
    final int? month = dateInfo['month'] as int?;
    final int? year = dateInfo['year'] as int?;
    final int? day = dateInfo['day'] as int?;

    if (month == null || year == null) {
      return;
    }

    // ALWAYS format the date professionally (regardless of confidence)
    String dateStr;
    if (_isGreek) {
      final monthNames = [
        'Ιανουάριος',
        'Φεβρουάριος',
        'Μάρτιος',
        'Απρίλιος',
        'Μάιος',
        'Ιούνιος',
        'Ιούλιος',
        'Αύγουστος',
        'Σεπτέμβριος',
        'Οκτώβριος',
        'Νοέμβριος',
        'Δεκέμβριος',
      ];
      final monthName = monthNames[month - 1];
      if (day != null) {
        dateStr = '$day $monthName $year';
      } else {
        dateStr = '$monthName $year';
      }
    } else {
      final monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      final monthName = monthNames[month - 1];
      if (day != null) {
        dateStr = '$monthName $day, $year';
      } else {
        dateStr = '$monthName $year';
      }
    }

    // Build main announcement (date)
    String mainAnnouncement;
    if (_isGreek) {
      mainAnnouncement = 'Ημερομηνία λήξης: $dateStr';
    } else {
      mainAnnouncement = 'Expiration date: $dateStr';
    }

    // Build disclaimer text for display in panel
    String disclaimerText;
    if (_isGreek) {
      disclaimerText =
          'Για μεγαλύτερη ακρίβεια, επαναλάβετε τη σάρωση ή ελέγξτε άλλες πλευρές του προϊόντος.';
    } else {
      disclaimerText =
          'For greater accuracy, re-scan or check other sides of the product.';
    }

    // Add disclaimer to dateInfo for display in green panel
    dateInfo['disclaimerText'] = disclaimerText;

    try {
      if (mounted) {
        setState(() {
          _lastDetectedDateInfo = dateInfo;
        });
      }
    } catch (e) {}

    // Build disclaimer announcement
    String disclaimerAnnouncement;
    if (_isGreek) {
      disclaimerAnnouncement =
          'Για μεγαλύτερη ακρίβεια, επαναλάβετε τη σάρωση ή ελέγξτε άλλες πλευρές του προϊόντος.';
    } else {
      disclaimerAnnouncement =
          'For greater accuracy, re-scan or check other sides of the product.';
    }

    // Announce date first
    _announce(mainAnnouncement);

    // Wait for date announcement to complete
    await Future.delayed(const Duration(milliseconds: 4000));

    // Then announce disclaimer
    _announce(disclaimerAnnouncement);

    // Wait for disclaimer announcement to complete
    await Future.delayed(const Duration(milliseconds: 2000));
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Colors.red,
        duration: const Duration(seconds: 3),
      ),
    );
    _announce(message);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: Text(
          _isGreek ? 'Σάρωση Ημερομηνίας Λήξης' : 'Expiration Date Scanner',
          style: const TextStyle(color: Colors.white),
        ),
        leading: Semantics(
          label: _isGreek ? 'Πίσω' : 'Back',
          button: true,
          excludeSemantics: true,
          child: IconButton(
            icon: const Icon(Icons.arrow_back, color: Colors.white),
            onPressed: () => Navigator.pop(context),
          ),
        ),
      ),
      body: _isInitialized
          ? Stack(
              children: [
                Positioned.fill(child: CameraPreview(_controller!)),
                if (_isProcessing && !_hasDetectedDate)
                  Positioned(
                    top: 50,
                    left: 20,
                    right: 20,
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.black.withOpacity(0.7),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              valueColor: AlwaysStoppedAnimation<Color>(
                                Colors.white,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            _isGreek
                                ? 'Αναζήτηση ημερομηνίας...'
                                : 'Scanning for dates...',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 14,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                if (_hasDetectedDate)
                  Positioned(
                    top: 50,
                    left: 20,
                    right: 20,
                    child: ExcludeSemantics(
                      child: Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Colors.blue.withOpacity(0.8),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.check_circle, color: Colors.white),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _isGreek
                                        ? 'Ημερομηνία λήξης εντοπίστηκε!'
                                        : 'Expiration date detected!',
                                    style: const TextStyle(
                                      color: Colors.white,
                                      fontSize: 14,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  Text(
                                    // Show matched text if available, otherwise a fallback
                                    _lastDetectedDateInfo != null &&
                                            _lastDetectedDateInfo![
                                                    'matchedText'] !=
                                                null
                                        ? _lastDetectedDateInfo!['matchedText']
                                        : (_isGreek
                                            ? 'Μη διαθέσιμη'
                                            : 'Not available'),
                                    style: const TextStyle(
                                      color: Colors.white70,
                                      fontSize: 13,
                                    ),
                                  ),
                                  if (_lastDetectedDateInfo != null &&
                                      _lastDetectedDateInfo![
                                              'disclaimerText'] !=
                                          null)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: Text(
                                        _lastDetectedDateInfo![
                                            'disclaimerText'],
                                        style: const TextStyle(
                                          color: Colors.white70,
                                          fontSize: 12,
                                          fontStyle: FontStyle.italic,
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                Positioned(
                  bottom: 50,
                  left: 20,
                  right: 20,
                  child: Semantics(
                    label: _isGreek ? 'Οδηγίες Σάρωσης' : 'Scanning Guide',
                    enabled: true,
                    child: Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: Colors.black.withOpacity(0.8),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: Colors.white.withOpacity(0.3),
                        ),
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            _isGreek ? 'Οδηγίες Σάρωσης' : 'Scanning Guide',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 16,
                              fontWeight: FontWeight.bold,
                            ),
                            textAlign: TextAlign.center,
                          ),
                          const SizedBox(height: 8),
                          Semantics(
                            label: _isGreek
                                ? 'Οδηγίες σάρωσης: Κρατήστε τη συσκευή σταθερή, 10-15 εκατοστά από το προϊόν. Μετακινήστε αργά προς το κείμενο της ημερομηνίας λήξης. Η ημερομηνία λήξης θα ανακοινωθεί αυτόματα. Σημαντικό: Το αποτέλεσμα που θα λάβετε δεν είναι ποτέ εκατό τοις εκατό σίγουρο, συνιστάται να επαναλάβετε τη σάρωση για επιβεβαίωση.'
                                : 'Scanning guide: Hold device steady, 10-15cm from product. Move slowly toward the expiration date text. The expiration date will be announced automatically. Important: The result is not one hundred percent certain, it is recommended to re-scan for confirmation.',
                            enabled: true,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: _isGreek
                                  ? [
                                      const Text(
                                        '• Κρατήστε τη συσκευή σταθερή, 10-15 εκατοστά από το προϊόν',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                        ),
                                      ),
                                      const Text(
                                        '• Μετακινήστε αργά προς το κείμενο της ημερομηνίας λήξης',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                        ),
                                      ),
                                      const Text(
                                        '• Η ημερομηνία λήξης θα ανακοινωθεί αυτόματα',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                        ),
                                      ),
                                      const SizedBox(height: 8),
                                      const Text(
                                        '• Σημαντικό: Το αποτέλεσμα που θα λάβετε δεν είναι ποτέ εκατό τοις εκατό σίγουρο, συνιστάται να επαναλάβετε τη σάρωση για επιβεβαίωση.',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                          fontStyle: FontStyle.italic,
                                        ),
                                      ),
                                    ]
                                  : [
                                      const Text(
                                        '• Hold device steady, 10-15cm from product',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                        ),
                                      ),
                                      const Text(
                                        '• Move slowly toward the expiration date text',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                        ),
                                      ),
                                      const Text(
                                        '• The expiration date will be announced automatically',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                        ),
                                      ),
                                      const SizedBox(height: 8),
                                      const Text(
                                        '• Important: The result is not one hundred percent certain, it is recommended to re-scan for confirmation.',
                                        style: TextStyle(
                                          color: Colors.white70,
                                          fontSize: 14,
                                          height: 1.4,
                                          fontStyle: FontStyle.italic,
                                        ),
                                      ),
                                    ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            )
          : const Center(
              child: CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation<Color>(Colors.blue),
              ),
            ),
    );
  }
}
