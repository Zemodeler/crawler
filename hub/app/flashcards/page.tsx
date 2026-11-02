"use client";
import { useEffect } from "react";
import { legacyPracticeUrl } from "../../lib/exam-focus.ts";

/**
 * The old address of Practice. Bookmarks, desktop shortcuts and links saved
 * before the rename land here and carry on to /practice with their parameters.
 */
export default function FlashcardsMoved() {
  useEffect(() => {
    window.location.replace(legacyPracticeUrl(window.location.search));
  }, []);
  return (
    <main className="calendar-message">
      <p>
        Flashcards are now part of <a href="/practice">Practice</a>. Taking you there...
      </p>
    </main>
  );
}
