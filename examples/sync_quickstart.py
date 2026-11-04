from selfgraph import KuzuStore, SyncSelfGraph


def main() -> None:
    with SyncSelfGraph(store=KuzuStore("sync.kuzu")) as graph:
        graph.entities.create("Acme", "Company", id="company:acme")
        graph.entities.create("Beta Corp", "Company", id="company:beta")
        graph.relations.create("company:acme", "ACQUIRED", "company:beta")

        for company in graph.entities.iterate(type="Company"):
            print(company.name)

        for relation in graph.relations.iterate():
            print(relation.from_entity, relation.type, relation.to_entity)


main()
