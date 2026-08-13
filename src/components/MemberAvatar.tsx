"use client";

import { useEffect, useState } from "react";

export function MemberAvatar({
  displayName,
  photoUrl,
  small = false,
}: {
  displayName: string;
  photoUrl?: string;
  small?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [photoUrl]);

  return (
    <span className={`memberAvatar${small ? " small" : ""}`} aria-hidden="true">
      <span className={loaded ? "memberAvatarInitial hidden" : "memberAvatarInitial"}>
        {displayName.trim().slice(0, 1)}
      </span>
      {photoUrl ? (
        <img
          alt=""
          className={loaded ? "memberAvatarPhoto loaded" : "memberAvatarPhoto"}
          onError={() => setLoaded(false)}
          onLoad={() => setLoaded(true)}
          src={photoUrl}
        />
      ) : null}
    </span>
  );
}
