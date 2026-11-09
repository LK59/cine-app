"""Regroupement et nom, sur des empreintes synthétiques.

Une identité = un vecteur unitaire de base ; ses pistes = la base plus un bruit de même ordre
de grandeur (similarité ~0,6 entre deux pistes, comme ArcFace sur des images de série), ses
photos = d'autres tirages, un peu plus bruités (autre éclairage, autre âge)."""

import numpy as np

from app.cluster import PersonRefs, cluster_embeddings, confidence, label_clusters
from conftest import noisy, unit

CLUSTER_T = 0.42
LABEL_T = 0.30


def identities(rng, n):
    return [unit(rng) for _ in range(n)]


def test_regroupe_par_identite():
    rng = np.random.default_rng(1)
    bases = identities(rng, 4)
    embs, truth = [], []
    for i, b in enumerate(bases):
        for _ in range(12 + 3 * i):
            embs.append(noisy(rng, b, 0.8))
            truth.append(i)
    labels = cluster_embeddings(np.stack(embs), CLUSTER_T)
    # Chaque identité tombe dans un seul groupe, et deux identités jamais dans le même.
    for i in range(4):
        assert len({l for l, t in zip(labels, truth) if t == i}) == 1
    assert len(set(labels)) == 4


def test_cas_limites():
    assert len(cluster_embeddings(np.zeros((0, 512), np.float32), CLUSTER_T)) == 0
    assert list(cluster_embeddings(np.ones((1, 512), np.float32), CLUSTER_T)) == [0]


def centroids_of(rng, bases, amount=0.5):
    return np.stack([noisy(rng, b, amount) for b in bases])


def test_nom_par_les_photos_un_a_un():
    rng = np.random.default_rng(2)
    bases = identities(rng, 3)
    cents = centroids_of(rng, bases)
    refs = [PersonRefs(100 + i, np.stack([noisy(rng, b, 1.0) for _ in range(4)])) for i, b in enumerate(bases)]
    out = label_clusters(cents, np.array([60.0, 30.0, 10.0]), refs, LABEL_T, CLUSTER_T)
    assert {i: a.person_id for i, a in out.items()} == {0: 100, 1: 101, 2: 102}
    assert all(0.5 <= a.confidence <= 1.0 for a in out.values())


def test_hors_distribution_reste_anonyme():
    rng = np.random.default_rng(3)
    bases = identities(rng, 3)
    cents = centroids_of(rng, bases)
    # Seules les deux premières personnes sont dans la distribution fournie.
    refs = [PersonRefs(100 + i, np.stack([noisy(rng, b, 1.0) for _ in range(3)])) for i, b in enumerate(bases[:2])]
    out = label_clusters(cents, np.array([10.0, 10.0, 50.0]), refs, LABEL_T, CLUSTER_T)
    assert {i: a.person_id for i, a in out.items()} == {0: 100, 1: 101}


def test_un_acteur_ne_nomme_qu_un_groupe_distinct():
    rng = np.random.default_rng(4)
    a, b = identities(rng, 2)
    # Le groupe 1 est un inconnu qui ressemble vaguement à A (sosie, flou) : A n'est attribué
    # qu'une fois, au groupe qui lui ressemble le plus.
    lookalike = noisy(rng, a, 2.2)
    cents = np.stack([noisy(rng, a, 0.4), lookalike, noisy(rng, b, 0.4)])
    refs = [PersonRefs(1, np.stack([noisy(rng, a, 0.9) for _ in range(4)])),
            PersonRefs(2, np.stack([noisy(rng, b, 0.9) for _ in range(4)]))]
    out = label_clusters(cents, np.array([30.0, 30.0, 30.0]), refs, LABEL_T, CLUSTER_T)
    assert out[0].person_id == 1 and out[2].person_id == 2
    assert 1 not in out


def test_seconde_passe_recolle_un_acteur_scinde():
    rng = np.random.default_rng(5)
    a = unit(rng)
    # Deux groupes du même acteur (proches l'un de l'autre, mais pas assez pour avoir fusionné).
    shift = unit(rng)
    c1 = a + 0.25 * shift
    c2 = a - 0.25 * shift
    cents = np.stack([c1 / np.linalg.norm(c1), c2 / np.linalg.norm(c2)])
    refs = [PersonRefs(9, np.stack([noisy(rng, a, 0.5) for _ in range(4)]))]
    out = label_clusters(cents, np.array([40.0, 15.0]), refs, LABEL_T, CLUSTER_T)
    assert {i: x.person_id for i, x in out.items()} == {0: 9, 1: 9}


def test_memoire_de_serie_sans_photo():
    rng = np.random.default_rng(6)
    a = unit(rng)
    refs = [PersonRefs(5, np.zeros((0, 512), np.float32), series=noisy(rng, a, 0.3))]
    out = label_clusters(np.stack([noisy(rng, a, 0.4)]), np.array([20.0]), refs, LABEL_T, CLUSTER_T)
    assert out[0].person_id == 5
    assert out[0].photo_score == -1.0


def test_confiance():
    assert abs(confidence(LABEL_T, LABEL_T) - 0.5) < 1e-9
    assert confidence(LABEL_T + 0.2, LABEL_T) > 0.9
    assert confidence(LABEL_T + 0.5, LABEL_T) <= 1.0
