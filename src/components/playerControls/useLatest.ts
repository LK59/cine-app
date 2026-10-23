"use client";

/**
 * Une référence qui reflète la dernière valeur rendue, pour un écouteur posé une seule fois (sur la
 * fenêtre, sur l'élément) qui doit lire la valeur du moment et non celle de sa pose. Mise à jour dans
 * un effet, jamais pendant le rendu (lint du React Compiler) : elle suit donc le rendu validé, à la
 * place où le hook est appelé parmi les effets du composant — un effet déclaré plus bas lit déjà la
 * nouvelle valeur.
 */

import { useEffect, useRef, type RefObject } from "react";

export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
